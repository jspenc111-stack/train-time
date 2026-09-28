// Runs the Apps Script code in Node with fake Google services.  Usage: node tests/run.js
process.env.TZ = 'America/New_York';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8');

// ── Fake Google services ──
// Apps Script hands back *signed* bytes (-128..127) and only accepts signed bytes, so the fakes do the same.
const toBuf = v => {
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  v.forEach(b => { if (!Number.isInteger(b) || b < -128 || b > 127) throw new Error('Apps Script needs signed bytes, got ' + b); });
  return Buffer.from(v.map(b => b & 0xff));
};
const signed = buf => Array.from(buf, b => (b > 127 ? b - 256 : b));
const b64url = buf => Buffer.from(buf).toString('base64url');

// A fixed test key (made-up; not used anywhere real)
const TEST_D = crypto.createHash('sha256').update('leave-by test key').digest();
const TEST_ECDH = crypto.createECDH('prime256v1');
TEST_ECDH.setPrivateKey(TEST_D);
const TEST_PUB = TEST_ECDH.getPublicKey();
const FCM = 'https://fcm.googleapis.com/fcm/send/test-device-1';

function makeEnv({ now, events = [], geocode, directions, sent = [], pushLog = [], pushStatus = () => 201, props = {}, mta = MTA, triggers = ['tick'] }) {
  const store = Object.assign({ API_KEY: 'k',
    SETTINGS: JSON.stringify({ homeAddress: 'Canal St Station, New York, NY' }),
    VAPID_PRIVATE: b64url(TEST_D), VAPID_PUBLIC: b64url(TEST_PUB),
    PUSH_DEVICES: JSON.stringify([{ endpoint: FCM, addedAt: 0 }]) }, props);
  Object.keys(store).forEach(k => { if (store[k] === undefined) delete store[k]; });
  const setProp = (k, v) => {
    if (Buffer.byteLength(String(v)) > 9000) throw new Error('Script Property too large: ' + k);
    store[k] = String(v);
  };
  const cache = {};
  const calls = { directions: 0, geocode: 0 };
  const logs = [];
  const ctx = {
    console,
    Logger: { log: s => logs.push(String(s)) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in store ? store[k] : null),
      setProperty: setProp,
      setProperties: o => Object.keys(o).forEach(k => setProp(k, o[k])),
      deleteProperty: k => { delete store[k]; }
    }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v, ttl) => {
      if (ttl > 21600) throw new Error('CacheService allows at most 6 hours');
      cache[k] = v;
    } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    Utilities: {
      formatDate: (d, tz, pat) => pat === 'H'
        ? String(Number(d.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false })) % 24)
        : pat === 'yyyy-MM-dd' ? d.toLocaleDateString('en-CA', { timeZone: tz })
        : d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }),
      getUuid: () => crypto.randomUUID(),
      computeHmacSha256Signature: (v, k) => signed(crypto.createHmac('sha256', toBuf(k)).update(toBuf(v)).digest()),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest: (alg, v) => { assert.strictEqual(alg, 'SHA_256'); return signed(crypto.createHash('sha256').update(toBuf(v)).digest()); },
      base64EncodeWebSafe: v => toBuf(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'), // padded, like Apps Script
      base64DecodeWebSafe: s => signed(Buffer.from(s, 'base64url'))
    },
    CalendarApp: {
      GuestStatus: { NO: 'NO' },
      getDefaultCalendar: () => ({
        getId: () => 'me@example.com',
        getEvents: (from, to) => events
          .filter(e => (e.end || new Date(e.start.getTime() + 3600000)) > from && e.start < to)
          .map(e => ({
            getId: () => e.id, getTitle: () => e.title, getLocation: () => e.location,
            getStartTime: () => e.start, getEndTime: () => e.end || new Date(e.start.getTime() + 3600000),
            isAllDayEvent: () => !!e.allDay, getMyStatus: () => e.status || 'YES', getEventType: () => e.type || 'DEFAULT'
          }))
      }),
      getAllCalendars: () => [{ getId: () => 'me@example.com', getName: () => 'Me' }, { getId: () => 'fam@group', getName: () => 'Family' }],
      getCalendarById: () => null
    },
    Maps: {
      DirectionFinder: { Mode: { TRANSIT: 'transit', WALKING: 'walking' } },
      newGeocoder: () => { const g = { setBounds: () => g, setRegion: () => g, geocode: loc => { calls.geocode++; return geocode(loc); } }; return g; },
      newDirectionFinder: () => {
        const q = {};
        const f = {
          setOrigin: v => (q.origin = v, f), setDestination: v => (q.dest = v, f), setRegion: () => f,
          setMode: v => (q.mode = v, f), setAlternatives: () => f, setArrive: v => (q.arrive = v, f),
          getDirections: () => { calls.directions++; return directions(q); }
        };
        return f;
      }
    },
    UrlFetchApp: { fetch: (url, opts) => {
      if (url.includes('mta.info')) return { getResponseCode: () => 200, getContentText: () => JSON.stringify(mta) };
      pushLog.push({ url, opts });
      const code = pushStatus(url);
      return { getResponseCode: () => code };
    } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ setMimeType: () => t }) },
    ScriptApp: {
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/X/exec' }),
      getProjectTriggers: () => triggers.map(h => ({ getHandlerFunction: () => h })),
      deleteTrigger: t => { triggers.splice(triggers.indexOf(t.getHandlerFunction()), 1); },
      newTrigger: h => { const b = { timeBased: () => b, everyMinutes: () => b, create: () => { triggers.push(h); } }; return b; }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  ctx.now_ = () => new Date(now.getTime());
  const notify = ctx.notify_;
  ctx.notify_ = function (msg, plan, st) { sent.push(msg); return notify(msg, plan, st); }; // record every message
  ctx.__store = store;
  ctx.__calls = calls;
  ctx.__logs = logs;
  ctx.__triggers = triggers;
  return ctx;
}

const MTA = { entity: [
  { id: '1', alert: { active_period: [{ start: 0 }], informed_entity: [{ route_id: 'A' }],
    header_text: { translation: [{ language: 'en', text: 'Northbound A trains are running with delays' }] } } },
  { id: '2', alert: { active_period: [{ start: 0, end: 10 }], informed_entity: [{ route_id: 'A' }],
    header_text: { translation: [{ language: 'en', text: 'Old alert' }] } } },
  { id: '3', alert: { active_period: [{ start: 0 }], informed_entity: [{ route_id: 'Q' }],
    header_text: { translation: [{ language: 'en', text: 'Q trains stop at 49 St' }] },
    'transit_realtime.mercury_alert': { alert_type: 'Planned - Stops Skipped' } } }
] };
const NO_ALERTS = { entity: [] };

// Event at 7:00 PM ET on 2026-09-28
const START = new Date('2026-09-28T19:00:00');
const min = m => m * 60000;
const sec = d => Math.round(d.getTime() / 1000);

function transitRoute(departMs, arriveMs, lines) {
  return { legs: [{
    departure_time: { value: sec(new Date(departMs)) },
    arrival_time: { value: sec(new Date(arriveMs)) },
    steps: [{ travel_mode: 'WALKING' }].concat(lines.map(([name, type]) => ({
      travel_mode: 'TRANSIT',
      transit_details: {
        line: { short_name: name, color: '#0039a6', vehicle: { type: type || 'SUBWAY' } },
        departure_stop: { name: 'Canal St' }, arrival_stop: { name: 'Spring St' },
        departure_time: { value: sec(new Date(departMs + min(2))) },
        arrival_time: { value: sec(new Date(arriveMs - min(3))) },
        headsign: 'Uptown', num_stops: 5
      }
    })))
  }] };
}

const geo = (address, types, comps, lat = 40.7278, lng = -74.0002) => ({ status: 'OK', results: [{
  formatted_address: address, types, geometry: { location: { lat, lng } }, address_components: comps }] });
const NY_STATE = { long_name: 'New York', short_name: 'NY', types: ['administrative_area_level_1'] };
const MANHATTAN = { long_name: 'Manhattan', short_name: 'Manhattan', types: ['political', 'sublocality', 'sublocality_level_1'] };
const NYC_GEO = geo('181 Thompson St, New York, NY 10012', ['street_address'], [MANHATTAN, NY_STATE]);
const MIDTOWN_GEO = geo('1 Rockefeller Plaza, New York, NY', ['premise'], [MANHATTAN, NY_STATE]);
const VAGUE_GEO = geo('Brooklyn, NY, USA', ['political', 'sublocality', 'sublocality_level_1'],
  [{ long_name: 'Brooklyn', short_name: 'Brooklyn', types: ['political', 'sublocality', 'sublocality_level_1'] }, NY_STATE]);
const NJ_GEO = geo('Hoboken, NJ', ['locality', 'political'],
  [{ long_name: 'New Jersey', short_name: 'NJ', types: ['administrative_area_level_1'] }], 40.744, -74.03);
const geocodeBy = map => loc => { for (const k in map) if (loc.includes(k)) return map[k]; return NYC_GEO; };

function defaultDirections(q) {
  if (q.mode === 'walking') return { status: 'OK', routes: [{ legs: [{ duration: { value: 35 * 60 } }] }] };
  const s = START.getTime();
  return { status: 'OK', routes: [
    transitRoute(s - min(40), s - min(7), [['A']]),         // 7 early ✓
    transitRoute(s - min(35), s - min(2), [['C']]),         // 2 early ✓ (tight)
    transitRoute(s - min(50), s - min(20), [['2']]),        // 20 early ✗
    transitRoute(s - min(38), s - min(4), [['M55', 'BUS']]) // bus ✗ (subway only)
  ] };
}
const S = env => env.settings_();

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n    ')); process.exitCode = 1; }
}

console.log('Leave By backend tests');

test('NYC + vague detection', () => {
  const env = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections });
  assert.strictEqual(env.isNyc_(NYC_GEO.results[0]), true);
  assert.strictEqual(env.isNyc_(NJ_GEO.results[0]), false);
  assert.strictEqual(env.isNyc_({ address_components: [
    { long_name: 'Kings County', short_name: 'Kings County', types: ['administrative_area_level_2'] }, NY_STATE] }), true);
  assert.strictEqual(env.isNyc_({ geometry: { location: { lat: 42.65, lng: -73.75 } }, address_components: [
    { long_name: 'Albany', short_name: 'Albany', types: ['locality'] }, NY_STATE] }), false);
  assert.strictEqual(env.isVague_(VAGUE_GEO.results[0]), true);
  assert.strictEqual(env.isVague_(NYC_GEO.results[0]), false);
});

test('recommends a train with a small buffer over a tight one; lists both', () => {
  const now = new Date(START.getTime() - min(180));
  const env = makeEnv({ now, geocode: () => NYC_GEO, directions: defaultDirections });
  const opts = env.pickTransitOptions_(defaultDirections({ mode: 'transit' }).routes, START.getTime(), now.getTime(), 5, [], S(env));
  assert.deepStrictEqual(Array.from(opts, o => o.legs[0].line), ['A', 'C']); // A (7 early) beats C (2 early)
  assert.strictEqual(opts[0].leaveAt, START.getTime() - min(45));          // depart −40, minus 5 min walk
});

test('avoids a delayed line when another train fits', () => {
  const now = new Date(START.getTime() - min(180));
  const env = makeEnv({ now, geocode: () => NYC_GEO, directions: defaultDirections });
  const alerts = env.parseMtaAlerts_(MTA, START.getTime());
  const opts = env.pickTransitOptions_(defaultDirections({ mode: 'transit' }).routes, START.getTime(), now.getTime(), 5, alerts, S(env));
  assert.strictEqual(opts[0].legs[0].line, 'C');
  assert.ok(opts[1].delayed);
});

test('adds a delay buffer when every option is delayed', () => {
  const now = new Date(START.getTime() - min(180));
  const env = makeEnv({ now, geocode: () => NYC_GEO, directions: defaultDirections });
  const s = START.getTime();
  const alerts = env.parseMtaAlerts_(MTA, s);
  const opts = env.pickTransitOptions_([transitRoute(s - min(40), s - min(7), [['A']])], s, now.getTime(), 5, alerts, S(env));
  assert.strictEqual(opts[0].delayBufferMin, 5);
  assert.strictEqual(opts[0].leaveAt, s - min(50));
});

test('MTA alerts: active only; planned work is not a delay', () => {
  const env = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections });
  const alerts = env.parseMtaAlerts_(MTA, START.getTime());
  assert.strictEqual(alerts.length, 2);
  assert.strictEqual(alerts.find(a => a.routes[0] === 'A').isDelay, true);
  assert.strictEqual(alerts.find(a => a.routes[0] === 'Q').isDelay, false);
});

test('falls back to the closest trains when none land in the window', () => {
  const now = new Date(START.getTime() - min(180));
  const env = makeEnv({ now, geocode: () => NYC_GEO, directions: defaultDirections });
  const s = START.getTime();
  const opts = env.pickTransitOptions_([transitRoute(s - min(60), s - min(15), [['R']]),
    transitRoute(s - min(70), s - min(25), [['W']])], s, now.getTime(), 5, [], S(env));
  assert.strictEqual(opts.length, 2);
  assert.strictEqual(opts[0].legs[0].line, 'R');
  assert.ok(opts[0].outsideWindow);
});

test('walks when close and not much slower; takes the train when walking is far slower', () => {
  const now = new Date(START.getTime() - min(180));
  const ev = { id: 'e', title: 'Coffee', location: 'Somewhere', start: START, end: new Date(START.getTime() + min(60)) };
  const home = { key: 'home', address: 'Canal St Station', label: 'home', walkMin: 5, fromHome: true };
  const walkDirs = w => q => q.mode === 'walking' ? { status: 'OK', routes: [{ legs: [{ duration: { value: w * 60 } }] }] } : defaultDirections(q);
  let env = makeEnv({ now, geocode: () => NYC_GEO, directions: walkDirs(12) });
  let plan = env.buildPlan_(ev, now, home, () => [], S(env));
  assert.strictEqual(plan.options[0].type, 'walk');
  assert.strictEqual(plan.options[0].leaveAt, START.getTime() - min(5 + 12 + 5));
  // 15-min walk (+5 to station = 20) vs 8 min door-to-door by train: take the train
  const fast = q => q.mode === 'walking' ? { status: 'OK', routes: [{ legs: [{ duration: { value: 15 * 60 } }] }] }
    : { status: 'OK', routes: [transitRoute(START.getTime() - min(10), START.getTime() - min(7), [['A']])] };
  env = makeEnv({ now, geocode: () => NYC_GEO, directions: fast });
  plan = env.buildPlan_(ev, now, home, () => [], S(env));
  assert.strictEqual(plan.options[0].type, 'transit');
});

test('skips virtual, all-day, declined, working-location events', () => {
  const now = new Date(START.getTime() - min(180));
  const events = [
    { id: '1', title: 'Zoom', location: 'https://zoom.us/j/1', start: START },
    { id: '2', title: 'Allday', location: 'Central Park', start: START, allDay: true },
    { id: '3', title: 'Nope', location: 'Central Park', start: START, status: 'NO' },
    { id: '4', title: 'Office', location: '1 Main St', start: START, type: 'WORKING_LOCATION' },
    { id: '5', title: 'Real', location: 'Central Park', start: START }
  ];
  const env = makeEnv({ now, events, geocode: () => NYC_GEO, directions: defaultDirections });
  assert.deepStrictEqual(Array.from(env.getEvents_(now, S(env)), e => e.id), ['5']);
});

test('multi-day events: ignored by default, planned when the setting is on; late dinners still count', () => {
  const now = new Date(START.getTime() - min(180));
  const events = [
    { id: 'conf', title: 'Conference', location: 'Javits Center', start: START, end: new Date(START.getTime() + min(60 * 48)) },
    { id: 'late', title: 'Late dinner', location: 'Carbone', start: new Date(START.getTime() + min(180)), end: new Date(START.getTime() + min(360)) } // 10pm–1am
  ];
  let env = makeEnv({ now, events, geocode: () => NYC_GEO, directions: defaultDirections });
  assert.deepStrictEqual(Array.from(env.getEvents_(now, S(env)), e => e.id), ['late']);
  env = makeEnv({ now, events, geocode: () => NYC_GEO, directions: defaultDirections,
    props: { SETTINGS: JSON.stringify({ homeAddress: 'Canal St Station', includeMultiDay: true }) } });
  assert.deepStrictEqual(Array.from(env.getEvents_(now, S(env)), e => e.id), ['conf', 'late']);
});

test('never plans a trip starting from a multi-day event', () => {
  const now = new Date(START.getTime() - min(60));
  const events = [
    { id: 'trip', title: 'Weekend away', location: 'Rockefeller Plaza', start: new Date(START.getTime() - min(60 * 30)), end: new Date(START.getTime() - min(30)) },
    { id: 'din', title: 'Dinner', location: 'Carbone', start: START }
  ];
  const env = makeEnv({ now, events, geocode: geocodeBy({ Rockefeller: MIDTOWN_GEO }), directions: defaultDirections, mta: NO_ALERTS,
    props: { SETTINGS: JSON.stringify({ homeAddress: 'Canal St Station', includeMultiDay: true }) } });
  const dinner = Object.values(env.runPlanner_(false).plans).find(p => p.title === 'Dinner');
  assert.strictEqual(dinner.fromHome, true);
});

test('plans from the previous event when it ends shortly before', () => {
  const now = new Date(START.getTime() - min(240));
  const events = [
    { id: 'lunch', title: 'Work lunch', location: 'Rockefeller Plaza', start: new Date(START.getTime() - min(180)), end: new Date(START.getTime() - min(60)) },
    { id: 'din', title: 'Dinner', location: 'Carbone', start: START }
  ];
  const origins = [];
  const dirs = q => { origins.push(q.origin); return defaultDirections(q); };
  const env = makeEnv({ now, events, geocode: geocodeBy({ Rockefeller: MIDTOWN_GEO }), directions: dirs, mta: NO_ALERTS });
  const store = env.runPlanner_(false);
  const dinner = Object.values(store.plans).find(p => p.title === 'Dinner');
  assert.strictEqual(dinner.fromHome, false);
  assert.strictEqual(dinner.originLabel, 'Work lunch');
  assert.ok(origins.includes('1 Rockefeller Plaza, New York, NY'));
  assert.strictEqual(dinner.options[0].leaveAt, START.getTime() - min(40)); // no walk-to-station from an event
  const lunch = Object.values(store.plans).find(p => p.title === 'Work lunch');
  assert.strictEqual(lunch.fromHome, true);
});

test('skipping the previous event plans from home instead', () => {
  const now = new Date(START.getTime() - min(240));
  const events = [
    { id: 'lunch', title: 'Work lunch', location: 'Rockefeller Plaza', start: new Date(START.getTime() - min(180)), end: new Date(START.getTime() - min(60)) },
    { id: 'din', title: 'Dinner', location: 'Carbone', start: START }
  ];
  const env = makeEnv({ now, events, geocode: geocodeBy({ Rockefeller: MIDTOWN_GEO }), directions: defaultDirections, mta: NO_ALERTS });
  let store = env.runPlanner_(false);
  const lunchKey = Object.keys(store.plans).find(k => k.startsWith('lunch'));
  env.doGet({ parameter: { key: 'k', action: 'skip', id: lunchKey } });
  store = env.runPlanner_(false);
  const dinner = Object.values(store.plans).find(p => p.title === 'Dinner');
  assert.strictEqual(dinner.fromHome, true);
  assert.strictEqual(store.plans[lunchKey].skipped, true);
});

test('non-NYC: silent. Vague location: one "can\'t plan" notice', () => {
  const log = [];
  const now = new Date(START.getTime() - min(60));
  const events = [
    { id: 'nj', title: 'Hoboken', location: 'Hoboken NJ', start: START },
    { id: 'bk', title: 'Party', location: 'Brooklyn', start: new Date(START.getTime() + min(30)) }
  ];
  let props;
  for (let i = 0; i < 3; i++) {
    const env = makeEnv({ now: new Date(now.getTime() + min(5 * i)), events, geocode: geocodeBy({ Hoboken: NJ_GEO, Brooklyn: VAGUE_GEO }), directions: defaultDirections, sent: log, props });
    const store = env.runPlanner_(false);
    props = env.__store;
    assert.deepStrictEqual(Object.values(store.plans).map(p => p.status).sort(), ['not_nyc', 'vague']);
  }
  assert.strictEqual(log.length, 1);
  assert.match(log[0].title, /^Can't plan: Party/);
});

test('notification stages fire once each, in order, tied to the event (for Skip)', () => {
  const log = [];
  const ev = { id: 'd', title: 'Dinner w/ Sam', location: 'Carbone, 181 Thompson St', start: START };
  const leaveAt = START.getTime() - min(45); // recommended = A (depart −40, minus 5)
  const times = [-200, -95, -85, -80, -30, -17, -12, -3, 0, 20].map(m => leaveAt + min(m));
  const stages = [];
  let props;
  for (const t of times) {
    const env = makeEnv({ now: new Date(t), events: [ev], geocode: () => NYC_GEO, directions: defaultDirections, sent: log, props, mta: NO_ALERTS });
    const before = log.length;
    env.runPlanner_(false);
    props = env.__store;
    if (log.length > before) stages.push([(t - leaveAt) / 60000, log[log.length - 1]]);
  }
  assert.deepStrictEqual(stages.map(s => s[0]), [-85, -17, -3]);
  assert.strictEqual(stages[0][1].title, 'Leave 6:15 PM → Dinner w/ Sam');
  assert.match(stages[1][1].title, /^Leave in 17 min \(6:15 PM\)$/);
  assert.match(stages[2][1].title, /^Leave now!/);
  assert.deepStrictEqual(stages.map(s => s[1].stage), ['headsup', 'warning', 'now']);
  assert.ok(stages.every(s => s[1].kind === 'trip'));
  console.log('    sample heads-up:\n      ' + stages[0][1].title + '\n      ' + stages[0][1].body.replace(/\n/g, '\n      '));
});

test('late-added event only sends the most urgent stage', () => {
  const log = [];
  const ev = { id: 'x', title: 'Late add', location: 'Carbone', start: START };
  const leaveAt = START.getTime() - min(45);
  const env = makeEnv({ now: new Date(leaveAt - min(10)), events: [ev], geocode: () => NYC_GEO, directions: defaultDirections, sent: log, mta: NO_ALERTS });
  env.runPlanner_(false);
  env.runPlanner_(false);
  assert.strictEqual(log.length, 1);
  assert.match(log[0].title, /^Leave in/);
});

test('sends a "Change" notice if the leave time moves after the heads-up', () => {
  const log = [];
  const ev = { id: 'd', title: 'Dinner', location: 'Carbone', start: START };
  let early = false;
  const dirs = q => {
    if (q.mode === 'walking') return { status: 'OK', routes: [{ legs: [{ duration: { value: 35 * 60 } }] }] };
    const s = START.getTime();
    return { status: 'OK', routes: [early ? transitRoute(s - min(55), s - min(8), [['2']]) : transitRoute(s - min(40), s - min(7), [['A']])] };
  };
  let env = makeEnv({ now: new Date(START.getTime() - min(120)), events: [ev], geocode: () => NYC_GEO, directions: dirs, sent: log, mta: NO_ALERTS });
  env.runPlanner_(false);
  assert.match(log[0].title, /^Leave 6:15 PM/);
  early = true; // e.g. service change: now need the 6:05 train
  env = makeEnv({ now: new Date(START.getTime() - min(100)), events: [ev], geocode: () => NYC_GEO, directions: dirs, sent: log, props: env.__store, mta: NO_ALERTS });
  env.runPlanner_(false);
  assert.strictEqual(log.length, 2);
  assert.strictEqual(log[1].title, 'Change: leave 6:00 PM (was 6:15 PM)');
  assert.strictEqual(log[1].kind, 'change');
  assert.strictEqual(log[1].urgency, 'high');
});

test('heads-ups during quiet hours are silent', () => {
  const log = [];
  const early = new Date('2026-09-28T08:00:00');
  const ev = { id: 'm', title: 'Breakfast', location: 'Carbone', start: early };
  const dirs = q => q.mode === 'walking' ? null : { status: 'OK', routes: [transitRoute(early.getTime() - min(30), early.getTime() - min(6), [['A']])] };
  const env = makeEnv({ now: new Date(early.getTime() - min(100)), events: [ev], geocode: () => NYC_GEO, directions: dirs, sent: log, mta: NO_ALERTS });
  env.runPlanner_(false); // 6:20 AM
  assert.strictEqual(log[0].stage, 'headsup');
  assert.strictEqual(log[0].silent, true);
  assert.strictEqual(env.loadStore_().outbox[0].silent, true);
  // same heads-up in the afternoon makes a sound
  const log2 = [];
  const env2 = makeEnv({ now: new Date(START.getTime() - min(120)), events: [{ id: 'd', title: 'Dinner', location: 'Carbone', start: START }], geocode: () => NYC_GEO, directions: defaultDirections, sent: log2, mta: NO_ALERTS });
  env2.runPlanner_(false);
  assert.strictEqual(log2[0].silent, false);
});

test('does not re-ask Google Maps every run (adaptive replanning)', () => {
  const ev = { id: 'd', title: 'Dinner', location: 'Carbone', start: START };
  let props;
  let total = 0;
  for (let m = 400; m > 250; m -= 5) { // leave time 3.4–6 hours away: replan hourly, not every 5 min
    const env = makeEnv({ now: new Date(START.getTime() - min(m)), events: [ev], geocode: () => NYC_GEO, directions: defaultDirections, props, mta: NO_ALERTS });
    env.runPlanner_(false);
    props = env.__store;
    total += env.__calls.directions;
  }
  assert.ok(total <= 9, 'directions calls: ' + total); // 3 replans × 3 calls (vs 30 runs)
});

test('storage splits large plans across properties (9 KB limit)', () => {
  const now = new Date(START.getTime() - min(300));
  const events = Array.from({ length: 12 }, (_, i) => ({ id: 'e' + i, title: 'Event ' + i + ' ' + 'x'.repeat(80), location: 'Place ' + i, start: new Date(START.getTime() + min(i)) }));
  const env = makeEnv({ now, events, geocode: () => NYC_GEO, directions: defaultDirections, mta: NO_ALERTS });
  env.runPlanner_(false);
  assert.ok(Number(env.__store.STORE_N) > 1);
  assert.strictEqual(Object.keys(env.loadStore_().plans).length, 12);
});

test('settings: saved from the app, sanitized, and used', () => {
  const env = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections });
  const out = JSON.parse(env.doPost({ postData: { contents: JSON.stringify({ key: 'k', action: 'saveSettings',
    settings: { walkToStationMin: 3, maxEarlyMin: -4, minEarlyMin: 2, headsUpMin: 9999, homeAddress: '  ', calendarIds: ['primary', 'fam@group'], directionsApp: 'waze' } }) } }));
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.settings.directionsApp, 'google'); // only google or citymapper
  assert.strictEqual(out.settings.walkToStationMin, 3);
  assert.strictEqual(out.settings.maxEarlyMin, 7);   // can't be below min → min + 5
  assert.strictEqual(out.settings.headsUpMin, 240);  // clamped
  assert.strictEqual(out.settings.homeAddress, ''); // blank → no personal default in the public code
  assert.deepStrictEqual(Array.from(out.settings.calendarIds), ['primary', 'fam@group']);
  const view = JSON.parse(env.doGet({ parameter: { key: 'k', action: 'settings' } }));
  assert.strictEqual(view.calendars.length, 2);
  assert.strictEqual(view.pushPublicKey, b64url(TEST_PUB));
  assert.strictEqual(view.pushDevices, 1);
  env.doPost({ postData: { contents: JSON.stringify({ key: 'k', action: 'saveSettings', settings: { directionsApp: 'citymapper' } }) } });
  assert.strictEqual(env.settings_().directionsApp, 'citymapper');
  assert.strictEqual(env.settings_().walkToStationMin, 3); // other settings kept
  assert.deepStrictEqual(JSON.parse(env.doPost({ postData: { contents: JSON.stringify({ key: 'bad', action: 'saveSettings' }) } })), { error: 'unauthorized' });
});

test('web API: key required everywhere (Skip too); app link remembered', () => {
  const now = new Date(START.getTime() - min(120));
  const env = makeEnv({ now, events: [{ id: 'd', title: 'Dinner', location: 'Carbone', start: START }], geocode: () => NYC_GEO, directions: defaultDirections });
  assert.deepStrictEqual(JSON.parse(env.doGet({ parameter: { key: 'bad' } })), { error: 'unauthorized' });
  assert.deepStrictEqual(JSON.parse(env.doGet({ parameter: {} })), { error: 'unauthorized' });
  const out = JSON.parse(env.doGet({ parameter: { key: 'k', action: 'refresh', app: 'https://me.github.io/leave-by/', self: 'https://script.google.com/macros/s/Y/exec' } }));
  assert.strictEqual(out.plans.length, 1);
  assert.strictEqual(out.plans[0].options[0].recommended, true);
  assert.strictEqual(env.settings_().appUrl, 'https://me.github.io/leave-by/');
  assert.ok(!Object.keys(env.__store).some(k => /URL/.test(k)), 'the script no longer stores its own link');
  const key = out.plans[0].key;
  assert.deepStrictEqual(JSON.parse(env.doGet({ parameter: { action: 'skip', id: key, t: 'anything' } })), { error: 'unauthorized' });
  assert.strictEqual(JSON.parse(env.doGet({ parameter: { key: 'k', action: 'skip', id: key } })).ok, true);
  assert.strictEqual(JSON.parse(env.doGet({ parameter: { key: 'k' } })).plans[0].skipped, true);
  env.doGet({ parameter: { key: 'k', action: 'unskip', id: key } });
  assert.strictEqual(JSON.parse(env.doGet({ parameter: { key: 'k' } })).plans[0].skipped, false);
  fs.writeFileSync(path.join(__dirname, 'sample-response.json'), JSON.stringify(out, null, 2));
});

test('getAppLink: one-tap link for /exec; a clear warning for the /dev test link', () => {
  const EXEC = 'https://script.google.com/macros/s/X/exec';
  const DEV = 'https://script.google.com/macros/s/D/dev';
  const run = getUrl => {
    const env = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections });
    env.ScriptApp.getService = () => ({ getUrl: () => getUrl });
    env.getAppLink();
    return env.__logs.join('\n');
  };
  let text = run(EXEC);
  assert.ok(text.includes('#api=' + encodeURIComponent(EXEC) + '&key=k'), text);
  assert.match(text, /Enable notifications/);
  text = run(DEV);
  assert.ok(!text.includes('#api='), text);
  assert.ok(text.includes('#key=k'), text);
  assert.match(text, /\/dev/);
  assert.match(text, /Manage deployments/);
  assert.match(text, /\/exec/);
});

test('skipped events get no notifications', () => {
  const log = [];
  const ev = { id: 'd', title: 'Dinner', location: 'Carbone', start: START };
  const env = makeEnv({ now: new Date(START.getTime() - min(300)), events: [ev], geocode: () => NYC_GEO, directions: defaultDirections, sent: log });
  const key = Object.keys(env.runPlanner_(false).plans)[0];
  env.setSkipped_(key, true);
  env.now_ = () => new Date(START.getTime() - min(50));
  env.runPlanner_(true);
  assert.strictEqual(log.length, 0);
});

test('no home set yet: events wait, app is told to ask for it', () => {
  const env = makeEnv({ now: new Date(START.getTime() - min(120)), events: [{ id: 'd', title: 'Dinner', location: 'Carbone', start: START }],
    geocode: () => NYC_GEO, directions: defaultDirections, props: { SETTINGS: '{}' } });
  const out = JSON.parse(env.doGet({ parameter: { key: 'k', action: 'refresh' } }));
  assert.strictEqual(out.needsHome, true);
  assert.strictEqual(out.plans[0].status, 'no_home');
  assert.strictEqual(out.version, env.VERSION);
});

test('privacy option hides event names and places in notifications', () => {
  const log = [];
  const ev = { id: 'd', title: 'Therapy', location: 'Secret Clinic, 5 Main St', start: START };
  const env = makeEnv({ now: new Date(START.getTime() - min(120)), events: [ev], geocode: () => NYC_GEO, directions: defaultDirections, sent: log, mta: NO_ALERTS,
    props: { SETTINGS: JSON.stringify({ homeAddress: 'Canal St Station', showEventDetails: false }) } });
  env.runPlanner_(false);
  const text = log.map(m => m.title + ' ' + m.body).join(' ');
  assert.ok(log.length === 1 && !/Therapy|Secret Clinic/.test(text), text);
  assert.match(log[0].title, /→ your event$/);
  const inbox = JSON.parse(env.doGet({ parameter: { key: 'k', action: 'inbox', since: '0' } }));
  assert.strictEqual(inbox.messages.length, 1);
  assert.ok(!/Therapy|Secret Clinic/.test(JSON.stringify(inbox) + JSON.stringify(env.loadStore_().outbox)));
});

test('app and backend versions match', () => {
  const app = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
  const env = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections });
  const m = app.match(/EXPECTED_BACKEND_VERSION = '([^']+)'/);
  assert.ok(m, 'EXPECTED_BACKEND_VERSION missing in web/app.js');
  assert.strictEqual(m[1], env.VERSION);
});

test('no personal details in public files', () => {
  const files = ['apps-script/Code.gs', 'web/app.js', 'web/links.js', 'web/kv.js', 'web/sw.js', 'web/index.html', 'SPEC.md', 'README.md', 'CLAUDE.md'];
  for (const f of files) {
    const p = path.join(__dirname, '..', f);
    if (!fs.existsSync(p)) continue;
    const txt = fs.readFileSync(p, 'utf8');
    assert.ok(!/@gmail\.com/i.test(txt), f + ' contains an email address');
    assert.ok(!/script\.google\.com\/macros\/s\/AKf/.test(txt), f + ' contains a real web app link');
    assert.ok(!/fcm\.googleapis\.com\/fcm\/send\/[\w-]{40,}/.test(txt), f + ' contains a real push device address');
  }
});

// ── §1 The old notification service is gone ──

const OLD_SERVICE = new RegExp('nt' + 'fy', 'i'); // spelled in two parts so this file passes its own check

test('no mention of the old notification service in any tracked file', () => {
  const { execSync } = require('child_process');
  const root = path.join(__dirname, '..');
  const files = execSync('git ls-files', { cwd: root, encoding: 'utf8' }).split('\n').filter(f => f && !/\.png$/.test(f));
  const hits = files.filter(f => fs.existsSync(path.join(root, f)) && OLD_SERVICE.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepStrictEqual(hits, []);
});

test('upgrade: setup() and the first tick() delete the old properties', () => {
  const OLD_TOPIC = 'N' + 'TFY_TOPIC';
  let env = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections,
    props: { [OLD_TOPIC]: 'old-topic', WEB_APP_URL: 'https://script.google.com/macros/s/X/exec' } });
  env.tick();
  assert.ok(!(OLD_TOPIC in env.__store) && !('WEB_APP_URL' in env.__store), Object.keys(env.__store).join(','));
  env = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections, triggers: [],
    props: { [OLD_TOPIC]: 'old-topic', WEB_APP_URL: 'x', VAPID_PRIVATE: undefined, VAPID_PUBLIC: undefined } });
  env.setup();
  assert.ok(!(OLD_TOPIC in env.__store) && !('WEB_APP_URL' in env.__store));
  assert.deepStrictEqual(Array.from(env.__triggers), ['tick']);
});

// ── §2 Push signing (VAPID, ES256 on P-256) ──

const nodePublicKey = pubBytes => crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
  x: b64url(pubBytes.slice(1, 33)), y: b64url(pubBytes.slice(33, 65)) } });

test('push keys: setup creates them; the public key matches Node for the same private key', () => {
  const env = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections, triggers: [],
    props: { VAPID_PRIVATE: undefined, VAPID_PUBLIC: undefined } });
  env.setup();
  const d = Buffer.from(env.__store.VAPID_PRIVATE, 'base64url');
  const pub = Buffer.from(env.__store.VAPID_PUBLIC, 'base64url');
  assert.strictEqual(d.length, 32);
  assert.strictEqual(pub.length, 65);
  assert.strictEqual(pub[0], 4);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  assert.strictEqual(pub.toString('hex'), ecdh.getPublicKey('hex'));
  // and for the fixed test key
  const env2 = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections });
  const derived = env2.p256PublicKey_(BigInt('0x' + TEST_D.toString('hex')));
  assert.strictEqual(Buffer.from(derived).toString('hex'), TEST_PUB.toString('hex'));
});

test('RFC 6979 A.2.5 test vector (P-256, SHA-256, "sample") gives the published r and s', () => {
  const env = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections });
  const d = BigInt('0xC9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721');
  const hash = Array.from(crypto.createHash('sha256').update('sample').digest());
  const sig = Buffer.from(env.ecdsaSignP256_(hash, d));
  assert.strictEqual(sig.length, 64);
  assert.strictEqual(sig.slice(0, 32).toString('hex').toUpperCase(), 'EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716');
  assert.strictEqual(sig.slice(32).toString('hex').toUpperCase(), 'F7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8');
});

test('VAPID JWT: verifies with Node, right claims (sub is the app link, never an email), cached per audience', () => {
  const env = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections });
  const jwt = env.vapidJwt_('https://fcm.googleapis.com');
  const [h, c, sig] = jwt.split('.');
  assert.deepStrictEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.strictEqual(claims.aud, 'https://fcm.googleapis.com');
  assert.strictEqual(claims.exp, Math.floor(START.getTime() / 1000) + 12 * 3600);
  assert.strictEqual(claims.sub, env.settings_().appUrl);
  assert.match(claims.sub, /^https:\/\//);
  assert.ok(!/@/.test(claims.sub));
  assert.ok(crypto.verify('sha256', Buffer.from(h + '.' + c), { key: nodePublicKey(TEST_PUB), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  assert.ok(env.verifyEs256_(h + '.' + c, sig, Array.from(TEST_PUB)));
  assert.strictEqual(env.vapidJwt_('https://fcm.googleapis.com'), jwt);         // cached
  assert.notStrictEqual(env.vapidJwt_('https://updates.push.services.mozilla.com'), jwt);
});

test('checkPush() confirms signing works and counts devices', () => {
  const env = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections });
  env.checkPush();
  const text = env.__logs.join('\n');
  assert.match(text, /✅ Push signing works/);
  assert.match(text, /1 device/);
});

// ── §3 Doorbell notifications ──

test('a notification stage adds an outbox message and rings every device with the right headers', () => {
  const pushLog = [];
  const devices = [{ endpoint: FCM, addedAt: 1 }, { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/abc', addedAt: 2 }];
  const ev = { id: 'd', title: 'Dinner', location: 'Carbone', start: START };
  const leaveAt = START.getTime() - min(45);
  let env = makeEnv({ now: new Date(leaveAt - min(60)), events: [ev], geocode: () => NYC_GEO, directions: defaultDirections, pushLog, mta: NO_ALERTS,
    props: { PUSH_DEVICES: JSON.stringify(devices) } });
  env.runPlanner_(false);
  assert.strictEqual(pushLog.length, 2);
  assert.deepStrictEqual(pushLog.map(r => r.url), devices.map(d => d.endpoint));
  const r0 = pushLog[0].opts;
  assert.strictEqual(r0.method, 'post');
  assert.strictEqual(r0.payload, '');
  assert.strictEqual(r0.muteHttpExceptions, true);
  assert.strictEqual(r0.headers.TTL, '1800');
  assert.strictEqual(r0.headers.Urgency, 'normal');
  const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(r0.headers.Authorization);
  assert.ok(m, r0.headers.Authorization);
  assert.strictEqual(m[2], b64url(TEST_PUB));
  const [h, c, sig] = m[1].split('.');
  assert.strictEqual(JSON.parse(Buffer.from(c, 'base64url')).aud, 'https://fcm.googleapis.com');
  assert.ok(crypto.verify('sha256', Buffer.from(h + '.' + c), { key: nodePublicKey(TEST_PUB), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  assert.strictEqual(JSON.parse(Buffer.from(pushLog[1].opts.headers.Authorization.split('.')[1], 'base64url')).aud, 'https://updates.push.services.mozilla.com');
  const box = env.loadStore_().outbox;
  assert.strictEqual(box.length, 1);
  assert.strictEqual(box[0].kind, 'trip');
  assert.strictEqual(box[0].urgency, 'normal');
  assert.ok(box[0].planKey && box[0].id > 0 && box[0].title && box[0].body);
  // "Leave now": high urgency, short TTL
  env = makeEnv({ now: new Date(leaveAt - min(2)), events: [ev], geocode: () => NYC_GEO, directions: defaultDirections, pushLog, mta: NO_ALERTS, props: env.__store });
  env.runPlanner_(false);
  assert.strictEqual(pushLog[2].opts.headers.Urgency, 'high');
  assert.strictEqual(pushLog[2].opts.headers.TTL, '600');
  assert.ok(env.loadStore_().outbox[1].id > box[0].id);
});

test('push service says the device is gone (410/404): the device is removed', () => {
  const devices = [{ endpoint: FCM, addedAt: 1 }, { endpoint: 'https://fcm.googleapis.com/fcm/send/other', addedAt: 2 }];
  const env = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections, props: { PUSH_DEVICES: JSON.stringify(devices) },
    pushStatus: url => (url === FCM ? 410 : 201) });
  const r = env.notify_({ title: 't', body: 'b', kind: 'test', urgency: 'normal' });
  assert.strictEqual(r.accepted, 1);
  assert.deepStrictEqual(Array.from(r.statuses), [410, 201]);
  assert.deepStrictEqual(JSON.parse(env.__store.PUSH_DEVICES).map(d => d.endpoint), ['https://fcm.googleapis.com/fcm/send/other']);
});

test('no devices: warns the app and still marks the stage sent (no pile-up)', () => {
  const log = [];
  const ev = { id: 'd', title: 'Dinner', location: 'Carbone', start: START };
  const env = makeEnv({ now: new Date(START.getTime() - min(120)), events: [ev], geocode: () => NYC_GEO, directions: defaultDirections, sent: log, mta: NO_ALERTS,
    props: { PUSH_DEVICES: undefined } });
  const store = env.runPlanner_(false);
  assert.strictEqual(log.length, 1);
  assert.ok(Object.values(store.plans)[0].sent.headsup);
  assert.strictEqual(store.pushWarning, 'no_device');
  assert.strictEqual(JSON.parse(env.doGet({ parameter: { key: 'k' } })).pushWarning, 'no_device');
  env.runPlanner_(false);
  assert.strictEqual(log.length, 1);
});

test('push service temporarily down: the stage is retried next run, without duplicate messages', () => {
  const log = [];
  let status = 503;
  const ev = { id: 'd', title: 'Dinner', location: 'Carbone', start: START };
  const env = makeEnv({ now: new Date(START.getTime() - min(120)), events: [ev], geocode: () => NYC_GEO, directions: defaultDirections, sent: log, mta: NO_ALERTS,
    pushStatus: () => status });
  env.runPlanner_(false);
  assert.strictEqual(env.loadStore_().outbox.length, 0);
  assert.ok(!Object.values(env.loadStore_().plans)[0].sent.headsup);
  assert.strictEqual(JSON.parse(env.__store.PUSH_DEVICES).length, 1); // kept
  status = 201;
  env.runPlanner_(false);
  assert.strictEqual(env.loadStore_().outbox.length, 1);
  assert.ok(Object.values(env.loadStore_().plans)[0].sent.headsup);
});

test('inbox: key required; only newer messages from the last 6 h, oldest first, at most 5; old ones pruned', () => {
  const env = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections });
  const H = 3600000;
  const st = env.loadStore_();
  st.outbox = [
    { id: 1, createdAt: START.getTime() - 30 * H, title: 'ancient', body: '' },
    { id: 2, createdAt: START.getTime() - 8 * H, title: 'old', body: '' }
  ];
  st.lastMsgId = 2;
  env.saveStore_(st);
  const ids = [];
  for (let i = 0; i < 7; i++) ids.push(env.notify_({ title: 'm' + i, body: 'b', kind: 'test', urgency: 'normal' }).id);
  assert.ok(ids.every((id, i) => i === 0 || id > ids[i - 1]), 'ids increase');
  const box = env.loadStore_().outbox;
  assert.ok(!box.some(m => m.title === 'ancient'), 'older than 24 h is dropped');
  assert.ok(box.some(m => m.title === 'old'));
  assert.deepStrictEqual(JSON.parse(env.doGet({ parameter: { action: 'inbox', since: '0' } })), { error: 'unauthorized' });
  let r = JSON.parse(env.doGet({ parameter: { key: 'k', action: 'inbox', since: '0' } }));
  assert.deepStrictEqual(r.messages.map(m => m.title), ['m2', 'm3', 'm4', 'm5', 'm6']);
  r = JSON.parse(env.doGet({ parameter: { key: 'k', action: 'inbox', since: String(ids[5]) } }));
  assert.deepStrictEqual(r.messages.map(m => m.title), ['m6']);
  // capped at 30
  for (let i = 0; i < 40; i++) env.notify_({ title: 'x', body: 'b', kind: 'test', urgency: 'normal' });
  assert.strictEqual(env.loadStore_().outbox.length, 30);
});

test('subscribe: key required, known push services only, at most 5 devices; unsubscribe removes', () => {
  const env = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections, props: { PUSH_DEVICES: undefined } });
  const post = body => JSON.parse(env.doPost({ postData: { contents: JSON.stringify(body) } }));
  assert.deepStrictEqual(post({ key: 'bad', action: 'subscribe', endpoint: FCM }), { error: 'unauthorized' });
  for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example.com/x', 'https://fcm.googleapis.com.evil.com/x', 'https://evil.com/?fcm.googleapis.com', 'javascript:alert(1)']) {
    assert.ok(post({ key: 'k', action: 'subscribe', endpoint: bad }).error, bad);
  }
  assert.strictEqual(env.__store.PUSH_DEVICES, undefined);
  const good = ['https://fcm.googleapis.com/fcm/send/a', 'https://updates.push.services.mozilla.com/wpush/v2/b',
    'https://wns2-par02p.notify.windows.com/w/?token=c', 'https://web.push.apple.com/d'];
  good.forEach(e => assert.strictEqual(post({ key: 'k', action: 'subscribe', endpoint: e }).ok, true));
  let r = post({ key: 'k', action: 'subscribe', endpoint: good[0] }); // again: no duplicate
  assert.strictEqual(r.devices, 4);
  assert.ok('lastId' in r);
  post({ key: 'k', action: 'subscribe', endpoint: 'https://fcm.googleapis.com/fcm/send/e' });
  r = post({ key: 'k', action: 'subscribe', endpoint: 'https://fcm.googleapis.com/fcm/send/f' });
  assert.strictEqual(r.devices, 5);
  const list = JSON.parse(env.__store.PUSH_DEVICES).map(d => d.endpoint);
  assert.ok(!list.includes(good[1]), 'oldest dropped first');
  assert.ok(JSON.parse(env.__store.PUSH_DEVICES).every(d => Object.keys(d).sort().join() === 'addedAt,endpoint'));
  r = post({ key: 'k', action: 'unsubscribe', endpoint: good[0] });
  assert.strictEqual(r.devices, 4);
});

test('test notification: rings devices and reports what happened', () => {
  let env = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections });
  let r = JSON.parse(env.doGet({ parameter: { key: 'k', action: 'test' } }));
  assert.deepStrictEqual([r.ok, r.accepted, r.devices], [true, 1, 1]);
  assert.deepStrictEqual(Array.from(r.statuses), [201]);
  assert.strictEqual(env.loadStore_().outbox[0].kind, 'test');
  env = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections, props: { PUSH_DEVICES: undefined } });
  r = JSON.parse(env.doGet({ parameter: { key: 'k', action: 'test' } }));
  assert.deepStrictEqual([r.ok, r.accepted, r.devices], [false, 0, 0]);
});

// ── §5 Fast settings ──

test('saving settings does no planning (0 Maps calls); plans include settings', () => {
  const ev = { id: 'd', title: 'Dinner', location: 'Carbone', start: START };
  const env = makeEnv({ now: new Date(START.getTime() - min(200)), events: [ev], geocode: () => NYC_GEO, directions: defaultDirections, mta: NO_ALERTS });
  env.doPost({ postData: { contents: JSON.stringify({ key: 'k', action: 'saveSettings', settings: { walkToStationMin: 9, homeAddress: 'Union Sq Station' } }) } });
  assert.strictEqual(env.__calls.directions + env.__calls.geocode, 0);
  const out = JSON.parse(env.doGet({ parameter: { key: 'k' } }));
  assert.strictEqual(out.settings.walkToStationMin, 9);
});

test('update after a save: notification-only changes re-plan nothing; walk time changes re-plan', () => {
  const ev = { id: 'd', title: 'Dinner', location: 'Carbone', start: START };
  const env = makeEnv({ now: new Date(START.getTime() - min(200)), events: [ev], geocode: () => NYC_GEO, directions: defaultDirections, mta: NO_ALERTS });
  env.runPlanner_(false);
  const save = st => env.doPost({ postData: { contents: JSON.stringify({ key: 'k', action: 'saveSettings', settings: st }) } });
  env.__calls.directions = 0;
  save({ headsUpMin: 60, warningMin: 10, quietStartHour: 23, quietEndHour: 6, showEventDetails: false, directionsApp: 'citymapper' });
  let out = JSON.parse(env.doGet({ parameter: { key: 'k', action: 'update' } }));
  assert.strictEqual(env.__calls.directions, 0);
  assert.strictEqual(out.plans.length, 1);
  save({ walkToStationMin: 12 });
  out = JSON.parse(env.doGet({ parameter: { key: 'k', action: 'update' } }));
  assert.ok(env.__calls.directions > 0);
  assert.strictEqual(out.plans[0].options[0].leaveAt, START.getTime() - min(40 + 12));
});

// ── §7 Directions ──

test('plans carry origin and destination with coordinates (no extra directions calls)', () => {
  const now = new Date(START.getTime() - min(240));
  const HOME_GEO = geo('Canal St, New York, NY 10013', ['subway_station'], [MANHATTAN, NY_STATE], 40.7191, -74.0014);
  const events = [
    { id: 'lunch', title: 'Work lunch', location: 'Rockefeller Plaza', start: new Date(START.getTime() - min(180)), end: new Date(START.getTime() - min(60)) },
    { id: 'din', title: 'Dinner', location: 'Carbone', start: START }
  ];
  const MID = geo('1 Rockefeller Plaza, New York, NY', ['premise'], [MANHATTAN, NY_STATE], 40.7587, -73.9787);
  const env = makeEnv({ now, events, geocode: geocodeBy({ Rockefeller: MID, Canal: HOME_GEO }), directions: defaultDirections, mta: NO_ALERTS });
  env.runPlanner_(false);
  assert.strictEqual(env.__calls.directions, 6); // 3 per event, as before
  const out = JSON.parse(env.doGet({ parameter: { key: 'k' } }));
  const lunch = out.plans.find(p => p.title === 'Work lunch');
  const dinner = out.plans.find(p => p.title === 'Dinner');
  assert.deepStrictEqual(lunch.origin, { address: 'Canal St Station, New York, NY', lat: 40.7191, lng: -74.0014, label: 'home' });
  assert.deepStrictEqual(lunch.dest, { address: '1 Rockefeller Plaza, New York, NY', lat: 40.7587, lng: -73.9787 });
  assert.deepStrictEqual(dinner.origin, { address: '1 Rockefeller Plaza, New York, NY', lat: 40.7587, lng: -73.9787, label: 'Work lunch' });
  assert.deepStrictEqual(dinner.dest, { address: '181 Thompson St, New York, NY 10012', lat: 40.7278, lng: -74.0002 });
});

const links = require('../web/links.js');

test('directions links: Google Maps (transit and walking), Citymapper with arrival time, fallback', () => {
  const plan = { title: 'Dinner & drinks', origin: { address: 'Canal St Station, New York, NY', lat: 40.7191, lng: -74.0014, label: 'home' },
    dest: { address: '181 Thompson St, New York, NY 10012', lat: 40.7278, lng: -74.0002 } };
  const train = { type: 'transit', arriveAt: new Date('2026-09-28T18:53:00-04:00').getTime() };
  const walk = { type: 'walk', arriveAt: train.arriveAt };
  assert.strictEqual(links.directionsUrl('google', plan, train),
    'https://www.google.com/maps/dir/?api=1&origin=Canal%20St%20Station%2C%20New%20York%2C%20NY&destination=181%20Thompson%20St%2C%20New%20York%2C%20NY%2010012&travelmode=transit');
  assert.match(links.directionsUrl('google', plan, walk), /&travelmode=walking$/);
  const cm = links.directionsUrl('citymapper', plan, train);
  assert.strictEqual(cm, 'https://citymapper.com/directions?startcoord=40.7191%2C-74.0014&startname=home&startaddress=Canal%20St%20Station%2C%20New%20York%2C%20NY' +
    '&endcoord=40.7278%2C-74.0002&endname=Dinner%20%26%20drinks&endaddress=181%20Thompson%20St%2C%20New%20York%2C%20NY%2010012&arrival_time=2026-09-28T18%3A53%3A00-04%3A00');
  const noCoords = Object.assign({}, plan, { dest: { address: plan.dest.address } });
  assert.match(links.directionsUrl('citymapper', noCoords, train), /^https:\/\/www\.google\.com\/maps\/dir\//);
  assert.strictEqual(links.directionsUrl('google', { title: 'x' }, train), null);
});

test('New York time offset is right in summer and winter', () => {
  assert.strictEqual(links.nyIso(new Date('2026-07-04T22:53:00Z').getTime()), '2026-07-04T18:53:00-04:00');
  assert.strictEqual(links.nyIso(new Date('2026-01-15T23:05:00Z').getTime()), '2026-01-15T18:05:00-05:00');
  assert.strictEqual(links.nyIso(new Date('2026-03-08T04:30:00Z').getTime()), '2026-03-07T23:30:00-05:00');
});

// ── §8 Connection check ──

test('ping: key required; reports version, timer, last run and devices', () => {
  const env = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections });
  assert.deepStrictEqual(JSON.parse(env.doGet({ parameter: { key: 'nope', action: 'ping' } })), { error: 'unauthorized' });
  env.runPlanner_(false);
  let r = JSON.parse(env.doGet({ parameter: { key: 'k', action: 'ping' } }));
  assert.deepStrictEqual([r.ok, r.version, r.hasTimer, r.lastRunAt, r.pushDevices, r.now], [true, env.VERSION, true, START.getTime(), 1, START.getTime()]);
  assert.strictEqual(r.pushPublicKey, b64url(TEST_PUB));
  const env2 = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections, triggers: [], props: { PUSH_DEVICES: undefined } });
  r = JSON.parse(env2.doGet({ parameter: { key: 'k', action: 'ping' } }));
  assert.deepStrictEqual([r.hasTimer, r.lastRunAt, r.pushDevices], [false, null, 0]);
});

// ── §9 Privacy ──

test('API key is compared in constant time', () => {
  const env = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections });
  assert.strictEqual(env.safeEqual_('abc', 'abc'), true);
  assert.strictEqual(env.safeEqual_('abc', 'abd'), false);
  assert.strictEqual(env.safeEqual_('abc', 'abcd'), false);
  assert.strictEqual(env.safeEqual_('', ''), false);
  assert.strictEqual(env.safeEqual_(undefined, 'k'), false);
  assert.match(src, /function keyOk_\([^)]*\) \{\s*return safeEqual_\(/);
  for (const fn of ['doGet', 'doPost']) {
    const body = src.slice(src.indexOf('function ' + fn + '('), src.indexOf('\n}\n', src.indexOf('function ' + fn + '(')));
    assert.match(body, /keyOk_\(/, fn + ' must check the key with keyOk_');
    assert.ok(!/=== .*API_KEY|API_KEY.* ===/.test(body), fn + ' compares the key directly');
  }
});

console.log(`\n${passed} passed`);
