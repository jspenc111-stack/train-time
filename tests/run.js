// Runs the Apps Script code in Node with fake Google services.  Usage: node tests/run.js
process.env.TZ = 'America/New_York';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8');

// ── Fake Google services ──
function makeEnv({ now, events = [], geocode, directions, ntfyLog = [], props = {}, mta = MTA }) {
  const store = Object.assign({ API_KEY: 'k', NTFY_TOPIC: 'topic', WEB_APP_URL: 'https://script.google.com/macros/s/X/exec',
    SETTINGS: JSON.stringify({ homeAddress: 'Canal St Station, New York, NY' }) }, props);
  const setProp = (k, v) => {
    if (Buffer.byteLength(String(v)) > 9000) throw new Error('Script Property too large: ' + k);
    store[k] = String(v);
  };
  const cache = {};
  const calls = { directions: 0, geocode: 0 };
  const ctx = {
    console,
    Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in store ? store[k] : null),
      setProperty: setProp,
      setProperties: o => Object.keys(o).forEach(k => setProp(k, o[k])),
      deleteProperty: k => { delete store[k]; }
    }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    Utilities: {
      formatDate: (d, tz, pat) => pat === 'H'
        ? String(Number(d.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false })) % 24)
        : pat === 'yyyy-MM-dd' ? d.toLocaleDateString('en-CA', { timeZone: tz })
        : d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }),
      getUuid: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      computeHmacSha256Signature: (v, k) => Array.from(crypto.createHmac('sha256', k).update(v).digest()).map(b => (b > 127 ? b - 256 : b))
    },
    CalendarApp: {
      GuestStatus: { NO: 'NO' },
      getDefaultCalendar: () => ({
        getId: () => 'me@gmail.com',
        getEvents: (from, to) => events
          .filter(e => (e.end || new Date(e.start.getTime() + 3600000)) > from && e.start < to)
          .map(e => ({
            getId: () => e.id, getTitle: () => e.title, getLocation: () => e.location,
            getStartTime: () => e.start, getEndTime: () => e.end || new Date(e.start.getTime() + 3600000),
            isAllDayEvent: () => !!e.allDay, getMyStatus: () => e.status || 'YES', getEventType: () => e.type || 'DEFAULT'
          }))
      }),
      getAllCalendars: () => [{ getId: () => 'me@gmail.com', getName: () => 'Me' }, { getId: () => 'fam@group', getName: () => 'Family' }],
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
      ntfyLog.push(JSON.parse(opts.payload));
      return { getResponseCode: () => 200 };
    } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ setMimeType: () => t }) },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/X/exec' }) }
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  ctx.now_ = () => new Date(now.getTime());
  ctx.__store = store;
  ctx.__calls = calls;
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
  env.doGet({ parameter: { action: 'skip', id: lunchKey, t: env.skipToken_(lunchKey) } });
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
    const env = makeEnv({ now: new Date(now.getTime() + min(5 * i)), events, geocode: geocodeBy({ Hoboken: NJ_GEO, Brooklyn: VAGUE_GEO }), directions: defaultDirections, ntfyLog: log, props });
    const store = env.runPlanner_(false);
    props = env.__store;
    assert.deepStrictEqual(Object.values(store.plans).map(p => p.status).sort(), ['not_nyc', 'vague']);
  }
  assert.strictEqual(log.length, 1);
  assert.match(log[0].title, /^Can't plan: Party/);
});

test('notification stages fire once each, in order, with a Skip button', () => {
  const log = [];
  const ev = { id: 'd', title: 'Dinner w/ Sam', location: 'Carbone, 181 Thompson St', start: START };
  const leaveAt = START.getTime() - min(45); // recommended = A (depart −40, minus 5)
  const times = [-200, -95, -85, -80, -30, -17, -12, -3, 0, 20].map(m => leaveAt + min(m));
  const stages = [];
  let props;
  for (const t of times) {
    const env = makeEnv({ now: new Date(t), events: [ev], geocode: () => NYC_GEO, directions: defaultDirections, ntfyLog: log, props, mta: NO_ALERTS });
    const before = log.length;
    env.runPlanner_(false);
    props = env.__store;
    if (log.length > before) stages.push([(t - leaveAt) / 60000, log[log.length - 1]]);
  }
  assert.deepStrictEqual(stages.map(s => s[0]), [-85, -17, -3]);
  assert.strictEqual(stages[0][1].title, 'Leave 6:15 PM → Dinner w/ Sam');
  assert.match(stages[1][1].title, /^Leave in 17 min \(6:15 PM\)$/);
  assert.match(stages[2][1].title, /^Leave now!/);
  assert.ok(stages[0][1].actions.some(a => a.action === 'http' && a.url.includes('action=skip')));
  console.log('    sample heads-up:\n      ' + stages[0][1].title + '\n      ' + stages[0][1].message.replace(/\n/g, '\n      '));
});

test('late-added event only sends the most urgent stage', () => {
  const log = [];
  const ev = { id: 'x', title: 'Late add', location: 'Carbone', start: START };
  const leaveAt = START.getTime() - min(45);
  const env = makeEnv({ now: new Date(leaveAt - min(10)), events: [ev], geocode: () => NYC_GEO, directions: defaultDirections, ntfyLog: log, mta: NO_ALERTS });
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
  let env = makeEnv({ now: new Date(START.getTime() - min(120)), events: [ev], geocode: () => NYC_GEO, directions: dirs, ntfyLog: log, mta: NO_ALERTS });
  env.runPlanner_(false);
  assert.match(log[0].title, /^Leave 6:15 PM/);
  early = true; // e.g. service change: now need the 6:05 train
  env = makeEnv({ now: new Date(START.getTime() - min(100)), events: [ev], geocode: () => NYC_GEO, directions: dirs, ntfyLog: log, props: env.__store, mta: NO_ALERTS });
  env.runPlanner_(false);
  assert.strictEqual(log.length, 2);
  assert.strictEqual(log[1].title, 'Change: leave 6:00 PM (was 6:15 PM)');
});

test('heads-ups during quiet hours are silent', () => {
  const log = [];
  const early = new Date('2026-09-28T08:00:00');
  const ev = { id: 'm', title: 'Breakfast', location: 'Carbone', start: early };
  const dirs = q => q.mode === 'walking' ? null : { status: 'OK', routes: [transitRoute(early.getTime() - min(30), early.getTime() - min(6), [['A']])] };
  const env = makeEnv({ now: new Date(early.getTime() - min(100)), events: [ev], geocode: () => NYC_GEO, directions: dirs, ntfyLog: log, mta: NO_ALERTS });
  env.runPlanner_(false); // 6:20 AM
  assert.strictEqual(log[0].priority, 2);
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
    settings: { walkToStationMin: 3, maxEarlyMin: -4, minEarlyMin: 2, headsUpMin: 9999, homeAddress: '  ', calendarIds: ['primary', 'fam@group'] } }) } }));
  assert.strictEqual(out.settings.walkToStationMin, 3);
  assert.strictEqual(out.settings.maxEarlyMin, 7);   // can't be below min → min + 5
  assert.strictEqual(out.settings.headsUpMin, 240);  // clamped
  assert.strictEqual(out.settings.homeAddress, ''); // blank → no personal default in the public code
  assert.deepStrictEqual(Array.from(out.settings.calendarIds), ['primary', 'fam@group']);
  assert.strictEqual(out.calendars.length, 2);
  assert.deepStrictEqual(JSON.parse(env.doPost({ postData: { contents: JSON.stringify({ key: 'bad', action: 'saveSettings' }) } })), { error: 'unauthorized' });
});

test('web API: key required; skip needs key or matching token; app links remembered', () => {
  const now = new Date(START.getTime() - min(120));
  const env = makeEnv({ now, events: [{ id: 'd', title: 'Dinner', location: 'Carbone', start: START }], geocode: () => NYC_GEO, directions: defaultDirections });
  assert.deepStrictEqual(JSON.parse(env.doGet({ parameter: { key: 'bad' } })), { error: 'unauthorized' });
  const out = JSON.parse(env.doGet({ parameter: { key: 'k', action: 'refresh', app: 'https://me.github.io/leave-by/', self: 'https://script.google.com/macros/s/Y/exec' } }));
  assert.strictEqual(out.plans.length, 1);
  assert.strictEqual(out.plans[0].options[0].recommended, true);
  assert.strictEqual(env.settings_().appUrl, 'https://me.github.io/leave-by/');
  assert.strictEqual(env.__store.WEB_APP_URL, 'https://script.google.com/macros/s/Y/exec');
  const key = out.plans[0].key;
  assert.deepStrictEqual(JSON.parse(env.doGet({ parameter: { action: 'skip', id: key, t: 'nope' } })), { error: 'unauthorized' });
  assert.strictEqual(JSON.parse(env.doGet({ parameter: { action: 'skip', id: key, t: env.skipToken_(key) } })).ok, true);
  assert.strictEqual(JSON.parse(env.doGet({ parameter: { key: 'k' } })).plans[0].skipped, true);
  env.doGet({ parameter: { key: 'k', action: 'unskip', id: key } });
  assert.strictEqual(JSON.parse(env.doGet({ parameter: { key: 'k' } })).plans[0].skipped, false);
  fs.writeFileSync(path.join(__dirname, 'sample-response.json'), JSON.stringify(out, null, 2));
});

test('getAppLink never hands out the /dev test link (the app can\'t use it)', () => {
  const EXEC = 'https://script.google.com/macros/s/X/exec';
  const DEV = 'https://script.google.com/macros/s/D/dev';
  const run = (getUrl, props) => {
    const env = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections, props });
    const logs = [];
    env.Logger = { log: s => logs.push(String(s)) };
    env.ScriptApp = { getService: () => ({ getUrl: () => getUrl }) };
    env.getAppLink();
    return { env, text: logs.join('\n') };
  };
  // Google gives the real /exec link: one-tap link as before
  let r = run(EXEC, { WEB_APP_URL: '' });
  assert.ok(r.text.includes('#api=' + encodeURIComponent(EXEC) + '&key=k'), r.text);
  assert.strictEqual(r.env.__store.WEB_APP_URL, EXEC);
  // Google gives /dev but the app already reported the /exec link: use that
  r = run(DEV, {});
  assert.ok(r.text.includes('#api=' + encodeURIComponent(EXEC) + '&key=k'), r.text);
  assert.strictEqual(r.env.__store.WEB_APP_URL, EXEC);
  // Only /dev known: key-only link plus steps to paste the /exec link
  r = run(DEV, { WEB_APP_URL: '' });
  assert.ok(!r.text.includes(DEV) && !r.text.includes(encodeURIComponent(DEV)), r.text);
  assert.ok(r.text.includes('#key=k'), r.text);
  assert.match(r.text, /Manage deployments/);
  assert.match(r.text, /\/exec/);
  assert.notStrictEqual(r.env.__store.WEB_APP_URL, DEV);
  // The app reporting a /dev link never replaces a good one
  r.env.__store.WEB_APP_URL = EXEC;
  r.env.doGet({ parameter: { key: 'k', self: DEV } });
  assert.strictEqual(r.env.__store.WEB_APP_URL, EXEC);
});

test('skipped events get no notifications', () => {
  const log = [];
  const ev = { id: 'd', title: 'Dinner', location: 'Carbone', start: START };
  const env = makeEnv({ now: new Date(START.getTime() - min(300)), events: [ev], geocode: () => NYC_GEO, directions: defaultDirections, ntfyLog: log });
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
  const env = makeEnv({ now: new Date(START.getTime() - min(120)), events: [ev], geocode: () => NYC_GEO, directions: defaultDirections, ntfyLog: log, mta: NO_ALERTS,
    props: { SETTINGS: JSON.stringify({ homeAddress: 'Canal St Station', showEventDetails: false }) } });
  env.runPlanner_(false);
  const text = log.map(m => m.title + ' ' + m.message).join(' ');
  assert.ok(log.length === 1 && !/Therapy|Secret Clinic/.test(text), text);
  assert.match(log[0].title, /→ your event$/);
});

test('app and backend versions match', () => {
  const app = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
  const env = makeEnv({ now: START, geocode: () => NYC_GEO, directions: defaultDirections });
  const m = app.match(/EXPECTED_BACKEND_VERSION = '([^']+)'/);
  assert.ok(m, 'EXPECTED_BACKEND_VERSION missing in web/app.js');
  assert.strictEqual(m[1], env.VERSION);
});

test('no personal details in public files', () => {
  const files = ['apps-script/Code.gs', 'web/app.js', 'web/index.html', 'SPEC.md', 'README.md', 'CLAUDE.md'];
  for (const f of files) {
    const p = path.join(__dirname, '..', f);
    if (!fs.existsSync(p)) continue;
    const txt = fs.readFileSync(p, 'utf8');
    assert.ok(!/@gmail\.com/i.test(txt), f + ' contains an email address');
    assert.ok(!/leaveby-[0-9a-f]{16}/.test(txt), f + ' contains a real ntfy topic');
    assert.ok(!/script\.google\.com\/macros\/s\/AKf/.test(txt), f + ' contains a real web app link');
  }
});

console.log(`\n${passed} passed`);
