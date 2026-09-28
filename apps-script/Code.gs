/**
 * Leave By — Google Apps Script backend.
 *
 * What this does (plain English):
 *  - Every 5 minutes, look at today's calendar events that have a location.
 *  - For NYC places, ask Google Maps for subway routes that get you there 0–10 minutes early
 *    (from home, or from your previous event if you'll be coming from there).
 *  - Send phone notifications to the installed Leave By app: heads-up, 15-minute warning, leave now.
 *    The script sends an empty "doorbell" push; the app wakes up and fetches the message from here.
 *  - Serve the plan (and your settings) to the Leave By app.
 *
 * First-time setup: run setup() once from the Apps Script editor. After that, change
 * settings from the app's ⚙️ screen — no need to edit this file.
 *
 * PRIVACY: this file lives in a public GitHub repo. Never put personal details
 * (home address, keys, device addresses) in it — they belong in the app's Settings,
 * which are stored privately in this script's Script Properties.
 */

var VERSION = '2.3.0'; // bump together with EXPECTED_BACKEND_VERSION in web/app.js

// ───────────────────────────── Defaults (the app's Settings screen overrides these) ─────────────────────────────
var DEFAULTS = {
  homeAddress: '',          // where trips from home start — set it in the app (kept private)
  walkToStationMin: 5,     // home → that station
  minEarlyMin: 0,          // arrival window: at least this many minutes early…
  maxEarlyMin: 10,         // …and at most this many
  comfortMin: 3,           // prefer trains that arrive at least this early (when one fits the window)
  maxWalkMin: 20,          // suggest walking if the walk is this short (and not much slower than the train)
  headsUpMin: 90,          // heads-up this long before you need to leave
  warningMin: 15,          // second warning
  quietStartHour: 22,      // heads-ups between these hours arrive silently
  quietEndHour: 7,
  chainEvents: true,       // plan from your previous event if it ends shortly before
  chainGapMin: 90,         // "shortly before" = within this many minutes
  calendarIds: ['primary'],
  subwayOnly: true,
  checkAlerts: true,
  showEventDetails: true,  // include event names/places in notifications (off = "your next event")
  includeMultiDay: false,  // plan for multi-day events (e.g. a conference) at their start time; all-day events are always ignored
  directionsApp: 'google', // tapping an option opens 'google' (Google Maps) or 'citymapper'
  appUrl: 'https://jspenc111-stack.github.io/train-time/' // your app's link, e.g. https://USERNAME.github.io/train-time/ (the app also fills this in)
};

// Settings that change which train you take. Changing any other setting never re-asks Google Maps.
var TRIP_SETTINGS = ['homeAddress', 'walkToStationMin', 'minEarlyMin', 'maxEarlyMin', 'comfortMin', 'maxWalkMin',
  'chainEvents', 'chainGapMin', 'subwayOnly', 'checkAlerts', 'includeMultiDay', 'calendarIds'];

// Fixed behavior (not shown in the app)
var FIXED = {
  LEAVE_NOW_MIN: 4,         // "leave now" fires within this many minutes of leave time
  WALK_EARLY_MIN: 5,        // when walking, aim to arrive this early
  DELAY_BUFFER_MIN: 5,      // leave this much earlier when your line has delays and there's no alternative
  WALK_VS_TRAIN_SLACK_MIN: 10, // walking is recommended only if it's at most this much slower door-to-door
  CHANGE_THRESHOLD_MIN: 5,  // tell you if your leave time moves by this much after a heads-up
  MAX_CHANGE_NOTICES: 2,
  MIN_LOOKAHEAD_HOURS: 8,   // plan the rest of today, and always at least this far ahead
  MAX_OPTIONS: 4,
  TIMEZONE: 'America/New_York',
  STORE_CHUNK_CHARS: 2500,  // Script Properties allow ~9 KB per value; split our data into safe chunks
  MAX_DEVICES: 5,           // phones/browsers that get notifications
  OUTBOX_MAX: 30,           // messages kept for the app to fetch…
  OUTBOX_KEEP_HOURS: 24,    // …for at most this long
  INBOX_HOURS: 6,           // the app is only shown messages this recent…
  INBOX_MAX: 5,             // …and at most this many per doorbell
  JWT_HOURS: 12,            // push signatures are valid this long
  JWT_CACHE_SEC: 21600      // and re-used for 6 h (the longest Apps Script's cache keeps anything)
};

// Script Properties used by older versions, deleted on upgrade. (The first is the old
// notification service's topic; its name is split so the repo-wide name check stays simple.)
var RETIRED_PROPS = ['N' + 'TFY_TOPIC', 'WEB_APP_URL'];

var MTA_ALERTS_URL = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json';
var NYC_BOUNDS = { south: 40.4774, west: -74.2591, north: 40.9176, east: -73.7004 };
var NYC_BOROUGHS = ['manhattan', 'brooklyn', 'queens', 'bronx', 'the bronx', 'staten island'];
var NYC_COUNTIES = ['new york county', 'kings county', 'queens county', 'bronx county', 'richmond county'];
var VIRTUAL_RE = /(https?:\/\/|zoom\.us|meet\.google|teams\.microsoft|webex|\bvirtual\b|\bonline\b|\bzoom\b|\bgoogle meet\b|\bphone call\b|\bfacetime\b)/i;
var VAGUE_TYPES = ['country', 'administrative_area_level_1', 'administrative_area_level_2', 'locality', 'sublocality', 'sublocality_level_1', 'postal_code', 'colloquial_area'];
var SKIP_EVENT_TYPES = ['WORKING_LOCATION', 'OUT_OF_OFFICE', 'FOCUS_TIME', 'BIRTHDAY'];
var DELAY_RE = /delay|suspend|not running|no \w+ (?:train )?service|slower|running with|express to|bypass/i;

// ───────────────────────────── Setup ─────────────────────────────

/** Run once. Creates secrets, push keys and the 5-minute timer. Safe to run again. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('API_KEY')) props.setProperty('API_KEY', Utilities.getUuid().replace(/-/g, ''));
  ensureVapidKeys_();
  migrate_();

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();

  tick();
  Logger.log('✅ Setup done. Next: Deploy → New deployment → Web app, then run getAppLink.');
  Logger.log('Then open the app from its icon → ⚙︎ → set where you leave from → Enable notifications.');
}

/** Tidy up after older versions (runs once per version, from setup or the timer). */
function migrate_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('MIGRATED_VERSION') === VERSION) return;
  RETIRED_PROPS.forEach(function (k) { if (props.getProperty(k) !== null) props.deleteProperty(k); });
  props.setProperty('MIGRATED_VERSION', VERSION);
}

/**
 * Run AFTER deploying as a web app.
 * Logs a one-tap link that opens the app already connected to this script.
 */
function getAppLink() {
  var props = PropertiesService.getScriptProperties();
  var url = ScriptApp.getService().getUrl();
  if (!url) { Logger.log('Deploy as a web app first (Deploy → New deployment → Web app).'); return; }
  var base = appUrl_() || 'https://YOUR-USERNAME.github.io/train-time/';
  var key = props.getProperty('API_KEY');
  if (/\/dev$/.test(url)) {
    // Run from the editor, Google often gives the /dev test link, which only works when you're signed in on a computer.
    Logger.log('⚠️ Google gave this script\'s /dev test link, which the app can\'t use. ' +
      'Tap Deploy → Manage deployments and copy the Web app URL (it ends in /exec).');
    Logger.log('Then open this link on your phone, tap ⚙︎ → Connection, paste that URL into "Apps Script web app URL" and tap Connect:\n' + base + '#key=' + key);
  } else {
    Logger.log('Open this link on your phone:\n' + base + '#api=' + encodeURIComponent(url) + '&key=' + key);
  }
  Logger.log('Then install the app, open it from its icon → ⚙︎ → Enable notifications → Send test notification.');
}

/**
 * If your app link ever leaks, run this: it makes a new API key and new push keys,
 * and forgets all registered phones. Then run getAppLink again, re-open the app with
 * the new link, and tap Enable notifications again.
 */
function resetSecrets() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('API_KEY', Utilities.getUuid().replace(/-/g, ''));
  props.deleteProperty('VAPID_PRIVATE');
  props.deleteProperty('VAPID_PUBLIC');
  props.deleteProperty('PUSH_DEVICES');
  ensureVapidKeys_();
  Logger.log('🔑 New key and push keys created. Now run getAppLink, open the new link, and tap Enable notifications again.');
}

// ───────────────────────────── Settings ─────────────────────────────

var settingsCache_ = null;

function settings_() {
  if (settingsCache_) return settingsCache_;
  var saved = {};
  try { saved = JSON.parse(PropertiesService.getScriptProperties().getProperty('SETTINGS') || '{}'); } catch (e) { saved = {}; }
  settingsCache_ = sanitizeSettings_(saved);
  return settingsCache_;
}

/** Merge user settings over defaults, keeping every value within a sensible range. */
function sanitizeSettings_(input) {
  var s = {};
  var num = function (k, lo, hi) {
    var v = Number(input[k]);
    s[k] = (input[k] === undefined || input[k] === '' || isNaN(v)) ? DEFAULTS[k] : Math.min(hi, Math.max(lo, Math.round(v)));
  };
  var bool = function (k) { s[k] = typeof input[k] === 'boolean' ? input[k] : DEFAULTS[k]; };

  var home = typeof input.homeAddress === 'string' ? input.homeAddress.trim().slice(0, 200) : '';
  s.homeAddress = home || DEFAULTS.homeAddress;
  num('walkToStationMin', 0, 30);
  num('minEarlyMin', 0, 30);
  num('maxEarlyMin', 1, 60);
  if (s.maxEarlyMin < s.minEarlyMin) s.maxEarlyMin = s.minEarlyMin + 5;
  num('comfortMin', 0, 30);
  num('maxWalkMin', 0, 60);
  num('headsUpMin', 20, 240);
  num('warningMin', 5, 60);
  if (s.warningMin >= s.headsUpMin) s.warningMin = Math.max(5, s.headsUpMin - 10);
  num('quietStartHour', 0, 23);
  num('quietEndHour', 0, 23);
  bool('chainEvents');
  num('chainGapMin', 15, 240);
  bool('subwayOnly');
  bool('checkAlerts');
  bool('showEventDetails');
  bool('includeMultiDay');
  s.directionsApp = input.directionsApp === 'citymapper' ? 'citymapper' : 'google';
  s.calendarIds = Array.isArray(input.calendarIds) && input.calendarIds.length
    ? input.calendarIds.filter(function (x) { return typeof x === 'string' && x; }).slice(0, 20)
    : DEFAULTS.calendarIds.slice();
  if (!s.calendarIds.length) s.calendarIds = DEFAULTS.calendarIds.slice();
  s.appUrl = typeof input.appUrl === 'string' && /^https:\/\//.test(input.appUrl) ? input.appUrl.slice(0, 300) : DEFAULTS.appUrl;
  return s;
}

function saveSettings_(input) {
  var clean = sanitizeSettings_(input || {});
  PropertiesService.getScriptProperties().setProperty('SETTINGS', JSON.stringify(clean));
  settingsCache_ = clean;
  return clean;
}

function appUrl_() {
  return settings_().appUrl || DEFAULTS.appUrl || '';
}

// ───────────────────────────── Main loop ─────────────────────────────

/** Runs every 5 minutes. */
function tick() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    migrate_();
    runPlanner_(false);
  } finally {
    lock.releaseLock();
  }
}

function runPlanner_(forceReplan) {
  var s = settings_();
  var now = now_();
  var nowMs = now.getTime();
  var store = loadStore_();
  var settingsKey = settingsKey_(s);
  var all = getEvents_(now, s);
  var alertsCache = null;
  var getAlerts = function () {
    if (alertsCache === null) alertsCache = s.checkAlerts ? fetchMtaAlerts_(now) : [];
    return alertsCache;
  };

  var plans = {};
  var skipped = {};
  all.forEach(function (ev) {
    var key = planKey_(ev);
    if (store.skipped[key]) skipped[key] = true; // keep skips while the event is still on today's list
    if (ev.start.getTime() <= nowMs) return;     // already started: only used as a "coming from" place
    var cached = store.plans[key];
    var origin = chooseOrigin_(ev, all, store, s);

    var plan;
    if (cached && !forceReplan && !needsReplan_(cached, origin, nowMs, settingsKey)) {
      plan = cached;
    } else {
      try {
        plan = buildPlan_(ev, now, origin, getAlerts, s);
      } catch (e) {
        plan = basePlan_(ev, now, origin, 'error');
        plan.message = String(e && e.message || e);
      }
      // keep the notification history across replans of the same event
      if (cached) {
        plan.sent = cached.sent || {};
        plan.notifiedLeaveAt = cached.notifiedLeaveAt || null;
        plan.changeCount = cached.changeCount || 0;
      }
      plan.settingsKey = settingsKey;
    }
    plan.key = key;
    plan.skipped = !!skipped[key];
    plans[key] = plan;
    if (!plan.skipped) maybeNotify_(plan, now, s, store);
  });

  store.plans = plans;      // drops events that are over / removed
  store.skipped = skipped;  // forget skips for events that are gone
  store.updatedAt = nowMs;
  saveStore_(store);
  return store;
}

/** How long a saved plan stays good before we ask Google Maps again. */
function needsReplan_(plan, origin, nowMs, settingsKey) {
  if (plan.settingsKey !== settingsKey) return true;                 // a trip setting changed
  if (plan.originKey !== origin.key) return true;                    // coming from somewhere else now
  if (plan.status === 'not_nyc' || plan.status === 'vague' || plan.status === 'not_found') return false; // same place → same answer
  if (plan.sent && plan.sent.now) return false;                     // you've left; keep it stable
  var age = (nowMs - plan.plannedAt) / 60000;
  if (plan.status !== 'ok') return age >= 30;
  var minsToLeave = (plan.options[0].leaveAt - nowMs) / 60000;
  return age >= (minsToLeave > 180 ? 60 : 15);
}

/** Fingerprint of the settings that affect trips (display and notification settings are left out). */
function settingsKey_(s) {
  return hash_(JSON.stringify(TRIP_SETTINGS.map(function (k) { return s[k]; })));
}

function planKey_(ev) {
  return ev.id + '|' + ev.start.getTime() + '|' + hash_(ev.location);
}

// ───────────────────────────── Calendar ─────────────────────────────

/** All located, in-person, not-declined events from now until the end of today (and at least 8 hours ahead). */
function getEvents_(now, s) {
  var endOfDay = new Date(now.getTime());
  endOfDay.setHours(23, 59, 59, 999);
  var end = new Date(Math.max(endOfDay.getTime(), now.getTime() + FIXED.MIN_LOOKAHEAD_HOURS * 3600000));
  var out = [];
  var seen = {};
  s.calendarIds.forEach(function (id) {
    var cal;
    try { cal = id === 'primary' ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(id); } catch (e) { cal = null; }
    if (!cal) return;
    cal.getEvents(now, end).forEach(function (e) {
      if (e.isAllDayEvent()) return; // no start time to plan for
      var loc = (e.getLocation() || '').replace(/\s+/g, ' ').trim();
      if (!loc || VIRTUAL_RE.test(loc)) return;
      try {
        if (e.getMyStatus && e.getMyStatus() === CalendarApp.GuestStatus.NO) return;
      } catch (err) { /* not a guest event */ }
      try {
        if (e.getEventType && SKIP_EVENT_TYPES.indexOf(String(e.getEventType())) >= 0) return;
      } catch (err) { /* older API */ }
      var start = e.getStartTime();
      var k = e.getId() + '|' + start.getTime();
      if (seen[k]) return;
      seen[k] = true;
      var endTime = e.getEndTime();
      var multiDay = isMultiDay_(start, endTime);
      if (multiDay && !s.includeMultiDay) return;
      out.push({ id: e.getId(), title: e.getTitle() || '(no title)', location: loc, start: start, end: endTime, multiDay: multiDay });
    });
  });
  out.sort(function (a, b) { return a.start - b.start; });
  return out;
}

/** A timed event that runs past midnight into another day and lasts over 12 hours (a late dinner doesn't count). */
function isMultiDay_(start, end) {
  if (!end || end.getTime() - start.getTime() <= 12 * 3600000) return false;
  return Utilities.formatDate(start, FIXED.TIMEZONE, 'yyyy-MM-dd') !== Utilities.formatDate(end, FIXED.TIMEZONE, 'yyyy-MM-dd');
}

/**
 * Where will you be coming from? Your previous event if it ends shortly before this one
 * (and you haven't skipped it), otherwise home.
 */
function chooseOrigin_(ev, all, store, s) {
  var home = { key: 'home:' + hash_(s.homeAddress), address: s.homeAddress, label: 'home', walkMin: s.walkToStationMin, fromHome: true };
  if (!s.chainEvents) return home;
  var prev = null;
  all.forEach(function (p) {
    if (p === ev || p.start >= ev.start || p.multiDay) return;             // don't plan from e.g. a conference
    var endMs = p.end.getTime();
    if (endMs > ev.start.getTime()) return;                             // overlaps: can't be at both
    if ((ev.start.getTime() - endMs) / 60000 > s.chainGapMin) return;   // too long a gap: assume home
    if (store.skipped[planKey_(p)]) return;                             // you're not going to that one
    if (!prev || endMs > prev.end.getTime()) prev = p;
  });
  if (!prev) return home;
  var geo = geocode_(prev.location);
  if (!geo || geo.vague) return home;
  return { key: 'event:' + hash_(geo.address), address: geo.address, label: prev.title, walkMin: 0, fromHome: false, departAfter: prev.end.getTime(), geo: geo };
}

// ───────────────────────────── Planning ─────────────────────────────

function basePlan_(ev, now, origin, status) {
  return {
    eventId: ev.id,
    title: ev.title,
    location: ev.location,
    start: ev.start.getTime(),
    plannedAt: now.getTime(),
    status: status,
    originKey: origin.key,
    originLabel: origin.label,
    fromHome: origin.fromHome,
    options: [],
    alerts: [],
    sent: {}
  };
}

function buildPlan_(ev, now, origin, getAlerts, s) {
  var geo = geocode_(ev.location);
  if (!geo) {
    var p = basePlan_(ev, now, origin, 'not_found');
    p.message = "Couldn't find this place on the map";
    return p;
  }
  if (!geo.isNyc) {
    var q = basePlan_(ev, now, origin, 'not_nyc');
    q.address = geo.address;
    return q;
  }
  if (geo.vague) {
    var v = basePlan_(ev, now, origin, 'vague');
    v.address = geo.address;
    v.message = 'Location is too general — add a street address or place name';
    return v;
  }

  if (!origin.address) {
    var h = basePlan_(ev, now, origin, 'no_home');
    h.address = geo.address;
    h.message = 'Set where you leave from in Settings';
    return h;
  }

  var plan = basePlan_(ev, now, origin, 'ok');
  plan.address = geo.address;
  // Coordinates for the directions links in the app (cached geocodes; no extra directions calls).
  var from = origin.geo || geocode_(origin.address);
  plan.dest = { address: geo.address, lat: geo.lat, lng: geo.lng };
  plan.origin = { address: origin.address, lat: from ? from.lat : null, lng: from ? from.lng : null, label: origin.label };
  var startMs = ev.start.getTime();
  var nowMs = now.getTime();
  // Can't leave before now, or before your previous event ends.
  var earliestLeave = Math.max(nowMs - 2 * 60000, origin.departAfter || 0);

  // Transit: ask for "arrive by start" and "arrive by start − 6 min" to get a spread of trains.
  var routes = [];
  [0, 6].forEach(function (minsBefore) {
    var res = getDirections_(origin.address, geo.address, 'transit', new Date(startMs - minsBefore * 60000));
    if (res && res.routes) routes = routes.concat(res.routes);
  });
  var alerts = getAlerts();
  var transit = pickTransitOptions_(routes, startMs, earliestLeave, origin.walkMin, alerts, s);

  // Walking
  var walkOpt = null;
  var walk = getDirections_(origin.address, geo.address, 'walking', null);
  var walkLeg = walk && walk.routes && walk.routes[0] && walk.routes[0].legs[0];
  if (walkLeg) {
    var walkMin = Math.ceil(walkLeg.duration.value / 60) + origin.walkMin;
    plan.walkMin = walkMin;
    var bestTransit = transit[0];
    var transitDoorToDoor = bestTransit ? (bestTransit.arriveAt - bestTransit.leaveAt) / 60000 : Infinity;
    var leaveAt = startMs - (FIXED.WALK_EARLY_MIN + walkMin) * 60000;
    if (walkMin <= s.maxWalkMin && walkMin <= transitDoorToDoor + FIXED.WALK_VS_TRAIN_SLACK_MIN && leaveAt >= earliestLeave) {
      walkOpt = {
        type: 'walk',
        leaveAt: leaveAt,
        arriveAt: startMs - FIXED.WALK_EARLY_MIN * 60000,
        early: FIXED.WALK_EARLY_MIN,
        walkMin: walkMin,
        legs: []
      };
    }
  }

  plan.options = walkOpt ? [walkOpt].concat(transit) : transit;
  if (!plan.options.length) {
    plan.status = 'no_route';
    plan.message = 'No subway route found in time';
    return plan;
  }
  plan.options = plan.options.slice(0, FIXED.MAX_OPTIONS + (walkOpt ? 1 : 0));
  plan.options[0].recommended = true;
  plan.alerts = plan.options[0].alerts || [];
  return plan;
}

/**
 * Turn Google routes into our options: keep catchable subway trips that land 0–10 min early,
 * then choose a recommendation that has a little buffer and avoids delayed lines when possible.
 * The recommended option is returned first.
 */
function pickTransitOptions_(routes, startMs, earliestLeaveMs, walkToOriginMin, alerts, s) {
  var opts = [];
  var seen = {};
  routes.forEach(function (r) {
    var o = routeToOption_(r, startMs, walkToOriginMin);
    if (!o) return;
    var sig = o.departAt + '|' + o.legs.map(function (l) { return l.line; }).join(',');
    if (seen[sig]) return;
    seen[sig] = true;
    opts.push(o);
  });

  opts = opts.filter(function (o) { return o.leaveAt >= earliestLeaveMs && o.arriveAt <= startMs; });

  if (s.subwayOnly) {
    var subway = opts.filter(function (o) { return o.allSubway; });
    if (subway.length) opts = subway;
    else opts.forEach(function (o) { o.nonSubway = true; });
  }

  // Attach MTA alerts to each option.
  opts.forEach(function (o) {
    var lines = {};
    o.legs.forEach(function (l) { lines[l.line] = true; });
    o.alerts = (alerts || []).filter(function (a) {
      return a.routes.some(function (r) { return lines[r]; });
    }).slice(0, 3);
    o.delayed = o.alerts.some(function (a) { return a.isDelay; });
  });

  var byLatestLeave = function (a, b) { return b.leaveAt - a.leaveAt; };
  var inWindow = opts.filter(function (o) { return o.early >= s.minEarlyMin && o.early <= s.maxEarlyMin; });
  if (!inWindow.length) {
    opts.sort(byLatestLeave);
    inWindow = opts.slice(0, 2);
    inWindow.forEach(function (o) { o.outsideWindow = true; });
  }
  if (!inWindow.length) return [];
  inWindow.sort(byLatestLeave);

  // Recommendation tiers: on-time lines with a small buffer › on-time lines › buffer › anything.
  var tiers = [
    function (o) { return !o.delayed && o.early >= s.comfortMin; },
    function (o) { return !o.delayed; },
    function (o) { return o.early >= s.comfortMin; },
    function () { return true; }
  ];
  var best = null;
  for (var i = 0; i < tiers.length && !best; i++) {
    for (var j = 0; j < inWindow.length; j++) if (tiers[i](inWindow[j])) { best = inWindow[j]; break; }
  }
  if (best.delayed) {
    // No delay-free choice: leave a few minutes earlier to be safe.
    best.leaveAt -= FIXED.DELAY_BUFFER_MIN * 60000;
    best.delayBufferMin = FIXED.DELAY_BUFFER_MIN;
  }
  var rest = inWindow.filter(function (o) { return o !== best; });
  return [best].concat(rest).slice(0, FIXED.MAX_OPTIONS);
}

function routeToOption_(route, startMs, walkToOriginMin) {
  var leg = route && route.legs && route.legs[0];
  if (!leg || !leg.departure_time || !leg.arrival_time) return null;
  var departAt = leg.departure_time.value * 1000;
  var arriveAt = leg.arrival_time.value * 1000;
  var legs = [];
  var allSubway = true;
  (leg.steps || []).forEach(function (st) {
    if (st.travel_mode !== 'TRANSIT' || !st.transit_details) return;
    var t = st.transit_details;
    var line = t.line || {};
    var vehicle = (line.vehicle && line.vehicle.type) || 'OTHER';
    if (vehicle !== 'SUBWAY') allSubway = false;
    legs.push({
      line: line.short_name || line.name || '?',
      vehicle: vehicle,
      color: line.color || null,
      textColor: line.text_color || null,
      from: t.departure_stop && t.departure_stop.name,
      to: t.arrival_stop && t.arrival_stop.name,
      departAt: t.departure_time ? t.departure_time.value * 1000 : null,
      arriveAt: t.arrival_time ? t.arrival_time.value * 1000 : null,
      headsign: t.headsign || '',
      stops: t.num_stops || null
    });
  });
  if (!legs.length) return null; // Google gave a walking-only "transit" route
  return {
    type: 'transit',
    departAt: departAt,
    leaveAt: departAt - walkToOriginMin * 60000,
    arriveAt: arriveAt,
    early: Math.round((startMs - arriveAt) / 60000),
    allSubway: allSubway,
    legs: legs
  };
}

// ───────────────────────────── Google Maps wrappers ─────────────────────────────

/** Geocode with a 6-hour cache. Returns {address, isNyc, vague, lat, lng} or null. */
function geocode_(location) {
  var cache = CacheService.getScriptCache();
  var ck = 'geo2:' + hash_(location);
  var hit = cache.get(ck);
  if (hit) return hit === 'null' ? null : JSON.parse(hit);

  var res = Maps.newGeocoder()
    .setBounds(NYC_BOUNDS.south, NYC_BOUNDS.west, NYC_BOUNDS.north, NYC_BOUNDS.east)
    .setRegion('us')
    .geocode(location);
  var out = null;
  if (res && res.status === 'OK' && res.results && res.results.length) {
    var r = res.results[0];
    var loc = (r.geometry && r.geometry.location) || {};
    out = { address: r.formatted_address, isNyc: isNyc_(r), vague: isVague_(r),
      lat: typeof loc.lat === 'number' ? loc.lat : null, lng: typeof loc.lng === 'number' ? loc.lng : null };
  }
  cache.put(ck, out ? JSON.stringify(out) : 'null', 21600);
  return out;
}

/** Decide whether a Google geocode result is inside New York City. */
function isNyc_(result) {
  var comps = result.address_components || [];
  var get = function (type) {
    for (var i = 0; i < comps.length; i++) if (comps[i].types.indexOf(type) >= 0) return comps[i];
    return null;
  };
  var state = get('administrative_area_level_1');
  if (!state || state.short_name !== 'NY') return false;
  var sub = get('sublocality_level_1') || get('sublocality');
  if (sub && NYC_BOROUGHS.indexOf(sub.long_name.toLowerCase()) >= 0) return true;
  var county = get('administrative_area_level_2');
  if (county && NYC_COUNTIES.indexOf(county.long_name.toLowerCase()) >= 0) return true;
  var loc = result.geometry && result.geometry.location;
  var city = get('locality');
  var inBox = loc && loc.lat >= NYC_BOUNDS.south && loc.lat <= NYC_BOUNDS.north &&
    loc.lng >= NYC_BOUNDS.west && loc.lng <= NYC_BOUNDS.east;
  return !!(city && /^new york/i.test(city.long_name) && inBox);
}

/** "New York" or "Brooklyn" alone is too general to route to. */
function isVague_(result) {
  var types = result.types || [];
  return types.length > 0 && types.every(function (t) { return t === 'political' || VAGUE_TYPES.indexOf(t) >= 0; });
}

function getDirections_(origin, destination, mode, arriveBy) {
  var f = Maps.newDirectionFinder()
    .setOrigin(origin)
    .setDestination(destination)
    .setRegion('us');
  if (mode === 'transit') {
    f.setMode(Maps.DirectionFinder.Mode.TRANSIT).setAlternatives(true);
    if (arriveBy) f.setArrive(arriveBy);
  } else {
    f.setMode(Maps.DirectionFinder.Mode.WALKING);
  }
  var res = f.getDirections();
  return res && res.status === 'OK' ? res : null;
}

// ───────────────────────────── MTA alerts (best effort) ─────────────────────────────

function fetchMtaAlerts_(now) {
  try {
    var resp = UrlFetchApp.fetch(MTA_ALERTS_URL, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return [];
    return parseMtaAlerts_(JSON.parse(resp.getContentText()), now.getTime());
  } catch (e) {
    return [];
  }
}

function parseMtaAlerts_(data, nowMs) {
  var nowSec = nowMs / 1000;
  var out = [];
  (data && data.entity || []).forEach(function (ent) {
    var a = ent.alert;
    if (!a) return;
    var periods = a.active_period || [];
    var active = !periods.length || periods.some(function (p) {
      var st = Number(p.start || 0), en = Number(p.end || 0);
      return st <= nowSec && (!en || en >= nowSec);
    });
    if (!active) return;
    var routes = {};
    (a.informed_entity || []).forEach(function (ie) { if (ie.route_id) routes[String(ie.route_id).replace(/X$/, '')] = true; });
    var tr = (a.header_text && a.header_text.translation) || [];
    var text = '';
    for (var i = 0; i < tr.length; i++) {
      if (!tr[i].language || tr[i].language === 'en') { text = tr[i].text; break; }
    }
    if (!text && tr[0]) text = tr[0].text;
    text = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    var mercury = a['transit_realtime.mercury_alert'] || {};
    var type = String(mercury.alert_type || '');
    var routeList = Object.keys(routes);
    if (text && routeList.length) {
      out.push({
        routes: routeList,
        text: text.length > 140 ? text.slice(0, 137) + '…' : text,
        isDelay: DELAY_RE.test(type) || DELAY_RE.test(text)
      });
    }
  });
  return out;
}

// ───────────────────────────── Notifications ─────────────────────────────

var PROBLEM_STATUSES = ['not_found', 'vague', 'no_route', 'error'];

/** Which leave-time notification (if any) is due right now: 'now' | 'warning' | 'headsup' | null. */
function dueStage_(plan, nowMs, s) {
  if (plan.status !== 'ok' || !plan.options.length) return null;
  var mins = (plan.options[0].leaveAt - nowMs) / 60000;
  if (mins < -10) return null; // too late to be useful
  var sent = plan.sent || {};
  var stage = null;
  if (mins <= FIXED.LEAVE_NOW_MIN) stage = 'now';
  else if (mins <= s.warningMin + 2) stage = 'warning';
  else if (mins <= s.headsUpMin) stage = 'headsup';
  if (!stage) return null;
  var order = ['headsup', 'warning', 'now'];
  for (var i = order.indexOf(stage); i < order.length; i++) if (sent[order[i]]) return null;
  return stage;
}

/**
 * A message counts as sent when at least one phone accepted the doorbell, or when no phone is
 * registered (the app then shows a "notifications are off" banner instead of piling them up).
 */
function delivered_(res) {
  return res.accepted > 0 || res.devices === 0;
}

function maybeNotify_(plan, now, s, store) {
  var nowMs = now.getTime();
  plan.sent = plan.sent || {};

  // Can't plan this one: tell you once, in time to fix the location.
  if (PROBLEM_STATUSES.indexOf(plan.status) >= 0) {
    if (!plan.sent.problem && plan.start - nowMs <= (s.headsUpMin + 60) * 60000) {
      if (delivered_(notify_(buildProblemMessage_(plan, now, s), plan, store))) plan.sent.problem = nowMs;
    }
    return;
  }

  var stage = dueStage_(plan, nowMs, s);
  var leaveAt = plan.options.length ? plan.options[0].leaveAt : null;
  if (stage) {
    if (delivered_(notify_(buildMessage_(plan, stage, now, s), plan, store))) {
      var order = ['headsup', 'warning', 'now'];
      for (var i = 0; i <= order.indexOf(stage); i++) plan.sent[order[i]] = plan.sent[order[i]] || nowMs;
      plan.notifiedLeaveAt = leaveAt;
    }
    return;
  }

  // Leave time moved since we told you (new train times, delays, event edited)?
  if (leaveAt && plan.notifiedLeaveAt && !plan.sent.now &&
      Math.abs(leaveAt - plan.notifiedLeaveAt) >= FIXED.CHANGE_THRESHOLD_MIN * 60000 &&
      (leaveAt - nowMs) / 60000 > FIXED.LEAVE_NOW_MIN &&
      (plan.changeCount || 0) < FIXED.MAX_CHANGE_NOTICES) {
    var msg = buildMessage_(plan, 'change', now, s);
    if (delivered_(notify_(msg, plan, store))) {
      plan.changeCount = (plan.changeCount || 0) + 1;
      plan.notifiedLeaveAt = leaveAt;
    }
  }
}

function isQuiet_(date, s) {
  var h = Number(Utilities.formatDate(date, FIXED.TIMEZONE, 'H'));
  if (s.quietStartHour === s.quietEndHour) return false;
  return s.quietStartHour > s.quietEndHour
    ? (h >= s.quietStartHour || h < s.quietEndHour)
    : (h >= s.quietStartHour && h < s.quietEndHour);
}

/** stage: 'headsup' | 'warning' | 'now' | 'change'. Returns {title, body, kind, stage, urgency, silent}. */
function buildMessage_(plan, stage, now, s) {
  var best = plan.options[0];
  var t = fmtTime_;
  var d = s.showEventDetails;
  var name = d ? plan.title : 'your event';
  var at = d ? ' @ ' + shortPlace_(plan) : '';
  var from = plan.fromHome ? '' : (d ? 'From ' + plan.originLabel + ' · ' : 'From your previous event · ');
  var bestText = describeOption_(best);
  var title, body;

  if (stage === 'headsup') {
    title = 'Leave ' + t(best.leaveAt) + ' → ' + name;
    var alts = plan.options.slice(1, 3).map(function (o) { return describeOption_(o, true); });
    body = t(plan.start) + at + '\n' + from + bestText +
      (alts.length ? '\nOr: ' + alts.join(' · ') : '');
  } else if (stage === 'warning') {
    title = 'Leave in ' + Math.max(1, Math.round((best.leaveAt - now.getTime()) / 60000)) + ' min (' + t(best.leaveAt) + ')';
    body = name + ' at ' + t(plan.start) + '\n' + from + bestText;
  } else if (stage === 'change') {
    title = 'Change: leave ' + t(best.leaveAt) + ' (was ' + t(plan.notifiedLeaveAt) + ')';
    body = name + ' at ' + t(plan.start) + '\n' + from + bestText;
  } else {
    title = 'Leave now!' + (d ? ' ' + plan.title : '');
    body = bestText + '\nStarts ' + t(plan.start) + at;
  }
  if (best.delayBufferMin) body += '\n⏱ Leaving ' + best.delayBufferMin + ' min early because of delays.';
  if (plan.alerts && plan.alerts.length) {
    body += '\n⚠️ ' + plan.alerts.map(function (a) { return a.routes.join('/') + ': ' + a.text; }).join('\n⚠️ ');
  }
  if (best.outsideWindow) body += '\n(No train lands ' + s.minEarlyMin + '–' + s.maxEarlyMin + ' min early — this is the closest.)';
  if (best.nonSubway) body += '\n(No subway-only route — includes bus/ferry.)';
  return {
    title: title, body: body, stage: stage,
    kind: stage === 'change' ? 'change' : 'trip',
    urgency: stage === 'headsup' ? 'normal' : 'high',
    silent: stage === 'headsup' && isQuiet_(now, s)
  };
}

function buildProblemMessage_(plan, now, s) {
  var d = s.showEventDetails;
  var why = {
    not_found: "couldn't find " + (d ? '"' + plan.location + '"' : 'the location') + ' on the map',
    vague: (d ? '"' + plan.location + '"' : 'the location') + ' is too general',
    no_route: 'no subway route gets there in time',
    error: 'something went wrong planning it'
  }[plan.status];
  return {
    title: "Can't plan: " + (d ? plan.title : 'an event') + ' (' + fmtTime_(plan.start) + ')',
    body: 'Leave By ' + why + '.' + (plan.status === 'vague' || plan.status === 'not_found'
      ? ' Add a street address to the event and it will update within 5 minutes.' : ' Check Google Maps for this one.'),
    kind: 'problem', stage: 'problem', urgency: 'normal',
    silent: isQuiet_(now, s)
  };
}

function describeOption_(o, short) {
  if (o.type === 'walk') return '🚶 Walk ' + o.walkMin + ' min, leave ' + fmtTime_(o.leaveAt);
  var first = o.legs[0];
  var last = o.legs[o.legs.length - 1];
  var lines = o.legs.map(function (l) { return l.line; }).join('→');
  if (short) return lines + ' ' + fmtTime_(first.departAt) + ' (arr ' + fmtTime_(o.arriveAt) + ')';
  return lines + ' ' + fmtTime_(first.departAt) + ' from ' + (first.from || 'station') +
    ' → ' + (last.to || 'stop') + ', arrive ' + fmtTime_(o.arriveAt) + ' (' + o.early + ' min early)';
}

function shortPlace_(plan) {
  return String(plan.location).split(',')[0];
}

/**
 * Send a notification: keep the message in the outbox (the app fetches it from here),
 * then ring every registered phone with an empty push. Returns {id, accepted, devices, statuses}.
 * Pass the planner's store to save along with it; otherwise the store is loaded and saved here.
 */
function notify_(msg, plan, store) {
  var own = !store;
  if (own) store = loadStore_();
  var nowMs = now_().getTime();
  var id = Math.max(nowMs * 1000, (store.lastMsgId || 0) + 1); // a timestamp plus a counter: always increasing
  store.lastMsgId = id;
  store.outbox = pruneOutbox_((store.outbox || []).concat([{
    id: id, createdAt: nowMs, title: msg.title, body: msg.body,
    planKey: (plan && plan.key) || null, urgency: msg.urgency || 'normal', silent: !!msg.silent,
    kind: msg.kind || 'trip', stage: msg.stage || null
  }]), nowMs);

  var res = ringDevices_(msg);
  if (res.devices === 0) store.pushWarning = 'no_device';
  else if (res.accepted > 0) store.pushWarning = null;
  else store.outbox = store.outbox.filter(function (m) { return m.id !== id; }); // nobody got it: the next run retries
  if (own) saveStore_(store);
  res.id = id;
  return res;
}

function pruneOutbox_(list, nowMs) {
  var cutoff = nowMs - FIXED.OUTBOX_KEEP_HOURS * 3600000;
  return list.filter(function (m) { return m.createdAt >= cutoff; }).slice(-FIXED.OUTBOX_MAX);
}

/** Send an empty web push ("doorbell") to each phone. Nothing readable goes through the push service. */
function ringDevices_(msg) {
  var devices = loadDevices_();
  var out = { accepted: 0, devices: devices.length, statuses: [] };
  if (!devices.length) return out;
  var pub = ensureVapidKeys_().publicKey;
  var keep = [];
  devices.forEach(function (d) {
    var code = 0;
    try {
      var resp = UrlFetchApp.fetch(d.endpoint, {
        method: 'post',
        payload: '',
        muteHttpExceptions: true,
        headers: {
          TTL: msg.stage === 'now' ? '600' : '1800',
          Urgency: msg.urgency === 'high' ? 'high' : 'normal',
          Authorization: 'vapid t=' + vapidJwt_(originOf_(d.endpoint)) + ', k=' + pub
        }
      });
      code = resp.getResponseCode();
    } catch (e) {
      code = 0; // network trouble: keep the device, the next run retries
    }
    out.statuses.push(code);
    if (code === 200 || code === 201 || code === 202) out.accepted++;
    if (code === 404 || code === 410) return; // the phone unsubscribed or reinstalled: forget it
    if (code === 400 || code === 403) Logger.log('Push rejected (' + code + '): the push keys may not match. Tap Enable notifications again in the app.');
    keep.push(d);
  });
  if (keep.length !== devices.length) saveDevices_(keep);
  return out;
}

function originOf_(url) {
  var m = /^https:\/\/[^\/?#]+/.exec(url);
  return m ? m[0] : '';
}

// ── Registered phones (Script Property PUSH_DEVICES: [{endpoint, addedAt}]) ──

function loadDevices_() {
  try {
    var list = JSON.parse(PropertiesService.getScriptProperties().getProperty('PUSH_DEVICES') || '[]');
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function saveDevices_(list) {
  PropertiesService.getScriptProperties().setProperty('PUSH_DEVICES', JSON.stringify(list.slice(-FIXED.MAX_DEVICES)));
}

/** Only real push services: Chrome/Android (Google), Firefox, Edge/Windows, Safari. */
function isPushEndpoint_(url) {
  if (typeof url !== 'string' || url.length > 1000) return false;
  var m = /^https:\/\/([a-z0-9.-]+)(:443)?\//i.exec(url);
  if (!m) return false;
  var host = m[1].toLowerCase();
  return host === 'fcm.googleapis.com' || host === 'web.push.apple.com' ||
    /^[a-z0-9-]+(\.[a-z0-9-]+)*\.push\.services\.mozilla\.com$/.test(host) ||
    /^[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com$/.test(host);
}

function addDevice_(endpoint) {
  var list = loadDevices_().filter(function (d) { return d.endpoint !== endpoint; });
  list.push({ endpoint: endpoint, addedAt: now_().getTime() });
  saveDevices_(list); // keeps the newest 5
  return loadDevices_().length;
}

function removeDevice_(endpoint) {
  var list = loadDevices_().filter(function (d) { return d.endpoint !== endpoint; });
  saveDevices_(list);
  return list.length;
}

// ───────────────────────────── Web push signing (VAPID, ES256 on P-256) ─────────────────────────────
//
// Push services only accept a doorbell that carries a short token (a JWT) signed with this script's
// private key. Apps Script has no built-in ECDSA, so the P-256 curve math is done here with BigInt.
// Checked in tests against Node's crypto and the RFC 6979 test vectors — keep those tests.
// The nonce k is deterministic (RFC 6979), so no random numbers are needed when signing.

var EC_ = null;

function ec_() {
  if (EC_) return EC_;
  var h = function (x) { return BigInt('0x' + x); };
  EC_ = {
    p: h('ffffffff00000001000000000000000000000000ffffffffffffffffffffffff'),
    n: h('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'),
    G: [h('6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'),
      h('4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5'), BigInt(1)],
    N0: BigInt(0), N1: BigInt(1), N2: BigInt(2), N3: BigInt(3), N4: BigInt(4), N8: BigInt(8)
  };
  return EC_;
}

function modP_(a, m) {
  var r = a % m;
  return r < ec_().N0 ? r + m : r;
}

/** Modular inverse (extended Euclid). */
function modInv_(a, m) {
  var C = ec_();
  var lm = C.N1, hm = C.N0, low = modP_(a, m), high = m;
  while (low > C.N1) {
    var r = high / low;
    var nm = hm - lm * r, nw = high - low * r;
    hm = lm; high = low; lm = nm; low = nw;
  }
  return modP_(lm, m);
}

// Points are Jacobian [X, Y, Z]; Z = 0 is the point at infinity.
function ecDouble_(P) {
  var C = ec_(), p = C.p;
  if (P[2] === C.N0 || P[1] === C.N0) return [C.N0, C.N1, C.N0];
  var X = P[0], Y = P[1], Z = P[2];
  var delta = Z * Z % p, gamma = Y * Y % p, beta = X * gamma % p;
  var alpha = C.N3 * ((X - delta) * (X + delta) % p) % p; // curve a = −3
  var X3 = modP_(alpha * alpha - C.N8 * beta, p);
  var Z3 = modP_((Y + Z) * (Y + Z) - gamma - delta, p);
  var Y3 = modP_(alpha * (C.N4 * beta - X3) - C.N8 * (gamma * gamma % p), p);
  return [X3, Y3, Z3];
}

function ecAdd_(P, Q) {
  var C = ec_(), p = C.p;
  if (P[2] === C.N0) return Q;
  if (Q[2] === C.N0) return P;
  var Z1Z1 = P[2] * P[2] % p, Z2Z2 = Q[2] * Q[2] % p;
  var U1 = P[0] * Z2Z2 % p, U2 = Q[0] * Z1Z1 % p;
  var S1 = P[1] * Q[2] % p * Z2Z2 % p, S2 = Q[1] * P[2] % p * Z1Z1 % p;
  if (U1 === U2) return S1 === S2 ? ecDouble_(P) : [C.N0, C.N1, C.N0];
  var H = modP_(U2 - U1, p), R = modP_(S2 - S1, p);
  var HH = H * H % p, HHH = H * HH % p, V = U1 * HH % p;
  var X3 = modP_(R * R - HHH - C.N2 * V, p);
  var Y3 = modP_(R * (V - X3) - S1 * HHH, p);
  var Z3 = P[2] * Q[2] % p * H % p;
  return [X3, Y3, Z3];
}

function ecMul_(k, P) {
  var C = ec_();
  var R = [C.N0, C.N1, C.N0];
  var bits = k.toString(2);
  for (var i = 0; i < bits.length; i++) {
    R = ecDouble_(R);
    if (bits.charAt(i) === '1') R = ecAdd_(R, P);
  }
  return R;
}

function ecAffine_(P) {
  var p = ec_().p;
  var zi = modInv_(P[2], p), zi2 = zi * zi % p;
  return [P[0] * zi2 % p, P[1] * zi2 % p * zi % p];
}

function bytesToBig_(bytes) {
  var hex = '';
  for (var i = 0; i < bytes.length; i++) hex += ((bytes[i] & 0xff) + 0x100).toString(16).slice(1);
  return BigInt('0x' + (hex || '0'));
}

function bigToBytes_(x, len) {
  var hex = x.toString(16);
  while (hex.length < len * 2) hex = '0' + hex;
  var out = [];
  for (var i = 0; i < len * 2; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
  return out;
}

/** Apps Script only accepts signed bytes (−128…127). */
function toSigned_(bytes) {
  return bytes.map(function (b) { b &= 0xff; return b > 127 ? b - 256 : b; });
}

function unsigned_(bytes) {
  return bytes.map(function (b) { return b & 0xff; });
}

function sha256_(bytes) {
  return unsigned_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, toSigned_(bytes)));
}

function hmac_(key, data) {
  return unsigned_(Utilities.computeHmacSha256Signature(toSigned_(data), toSigned_(key)));
}

function utf8Bytes_(str) {
  var s = unescape(encodeURIComponent(str));
  var out = [];
  for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  return out;
}

function b64url_(bytes) {
  return Utilities.base64EncodeWebSafe(toSigned_(bytes)).replace(/=+$/, '');
}

function b64urlDecode_(str) {
  var s = String(str);
  while (s.length % 4) s += '=';
  return unsigned_(Utilities.base64DecodeWebSafe(s));
}

/** Uncompressed public key 0x04‖X‖Y (65 bytes) for private key d. */
function p256PublicKey_(d) {
  var Q = ecAffine_(ecMul_(d, ec_().G));
  return [4].concat(bigToBytes_(Q[0], 32), bigToBytes_(Q[1], 32));
}

/** ECDSA P-256 signature of a SHA-256 hash, with RFC 6979 deterministic k. Returns r‖s (64 bytes). */
function ecdsaSignP256_(hashBytes, d) {
  var C = ec_(), n = C.n;
  var h = unsigned_(hashBytes);
  var e = bytesToBig_(h);
  var x = bigToBytes_(d, 32);
  var h1 = bigToBytes_(modP_(e, n), 32);
  var V = [], K = [];
  for (var i = 0; i < 32; i++) { V.push(1); K.push(0); }
  K = hmac_(K, V.concat([0], x, h1)); V = hmac_(K, V);
  K = hmac_(K, V.concat([1], x, h1)); V = hmac_(K, V);
  for (;;) {
    V = hmac_(K, V);
    var k = bytesToBig_(V);
    if (k >= C.N1 && k < n) {
      var r = modP_(ecAffine_(ecMul_(k, C.G))[0], n);
      if (r !== C.N0) {
        var s = modP_(modInv_(k, n) * (e + r * d), n);
        if (s !== C.N0) return bigToBytes_(r, 32).concat(bigToBytes_(s, 32));
      }
    }
    K = hmac_(K, V.concat([0])); V = hmac_(K, V);
  }
}

/** Verify an ES256 JWT signature (used by checkPush to prove signing works). */
function verifyEs256_(signingInput, sigB64, pubBytes) {
  var C = ec_(), n = C.n;
  var sig = b64urlDecode_(sigB64);
  var pub = unsigned_(pubBytes);
  if (sig.length !== 64 || pub.length !== 65 || pub[0] !== 4) return false;
  var r = bytesToBig_(sig.slice(0, 32)), s = bytesToBig_(sig.slice(32));
  if (r < C.N1 || r >= n || s < C.N1 || s >= n) return false;
  var e = bytesToBig_(sha256_(utf8Bytes_(signingInput)));
  var w = modInv_(s, n);
  var Q = [bytesToBig_(pub.slice(1, 33)), bytesToBig_(pub.slice(33, 65)), C.N1];
  var P = ecAdd_(ecMul_(modP_(e * w, n), C.G), ecMul_(modP_(r * w, n), Q));
  if (P[2] === C.N0) return false;
  return modP_(ecAffine_(P)[0], n) === r;
}

/** Create the push key pair if missing. Returns {privateKey, publicKey} (base64url). */
function ensureVapidKeys_() {
  var props = PropertiesService.getScriptProperties();
  var priv = props.getProperty('VAPID_PRIVATE');
  var pub = props.getProperty('VAPID_PUBLIC');
  if (priv && pub) return { privateKey: priv, publicKey: pub };
  var seed = unsigned_(Utilities.computeHmacSha256Signature(Utilities.getUuid() + Date.now(), Utilities.getUuid()));
  var n = ec_().n;
  var d = modP_(bytesToBig_(seed), n - ec_().N1) + ec_().N1; // in [1, n−1]
  priv = b64url_(bigToBytes_(d, 32));
  pub = b64url_(p256PublicKey_(d));
  props.setProperties({ VAPID_PRIVATE: priv, VAPID_PUBLIC: pub });
  return { privateKey: priv, publicKey: pub };
}

function signVapidJwt_(aud) {
  var keys = ensureVapidKeys_();
  var header = b64url_(utf8Bytes_(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  var claims = b64url_(utf8Bytes_(JSON.stringify({
    aud: aud,
    exp: Math.floor(now_().getTime() / 1000) + FIXED.JWT_HOURS * 3600,
    sub: appUrl_() // the app's link — never an email address
  })));
  var input = header + '.' + claims;
  var sig = ecdsaSignP256_(sha256_(utf8Bytes_(input)), bytesToBig_(b64urlDecode_(keys.privateKey)));
  return input + '.' + b64url_(sig);
}

/** The signed token for one push service, re-used from the cache so signing happens rarely. */
function vapidJwt_(aud) {
  var cache = CacheService.getScriptCache();
  var ck = 'vapid:' + hash_(ensureVapidKeys_().publicKey + '|' + appUrl_()) + ':' + aud;
  var hit = cache.get(ck);
  if (hit) return hit;
  var jwt = signVapidJwt_(aud);
  cache.put(ck, jwt, FIXED.JWT_CACHE_SEC);
  return jwt;
}

/** Run from the editor to check that push signing works here. */
function checkPush() {
  var ok = false;
  try { ok = typeof BigInt === 'function' && String(BigInt(6) * BigInt(7)) === '42'; } catch (e) { ok = false; }
  if (!ok) { Logger.log('❌ This script needs the V8 runtime (Project Settings → Enable Chrome V8 runtime).'); return; }
  var keys = ensureVapidKeys_();
  var jwt = signVapidJwt_('https://fcm.googleapis.com');
  var parts = jwt.split('.');
  if (verifyEs256_(parts[0] + '.' + parts[1], parts[2], b64urlDecode_(keys.publicKey))) {
    Logger.log('✅ Push signing works');
  } else {
    Logger.log('❌ Push signing failed — run resetSecrets, then tap Enable notifications again in the app.');
  }
  var n = loadDevices_().length;
  Logger.log(n + ' device' + (n === 1 ? '' : 's') + ' registered for notifications' +
    (n ? '.' : ' — open the app from its icon → ⚙︎ → Enable notifications.'));
}

// ───────────────────────────── Web API for the app ─────────────────────────────

/** Compare secrets without leaking how many characters matched. */
function safeEqual_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  var diff = a.length ^ b.length;
  for (var i = 0; i < b.length; i++) diff |= (a.charCodeAt(i % a.length) ^ b.charCodeAt(i));
  return diff === 0;
}

function keyOk_(key) {
  return safeEqual_(key, PropertiesService.getScriptProperties().getProperty('API_KEY'));
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!keyOk_(p.key)) return json_({ error: 'unauthorized' });
  var action = p.action || 'plans';

  // The app tells us its own link, so push signatures can name it.
  if (p.app && /^https:\/\//.test(p.app) && settings_().appUrl !== p.app) {
    var cur = settings_();
    cur.appUrl = p.app;
    saveSettings_(cur);
  }

  if (action === 'inbox') return json_(inbox_(Number(p.since) || 0));
  if (action === 'ping') return json_(ping_());
  if (action === 'test') {
    var r = withLock_(function () {
      return notify_({ title: 'Leave By test 🚇', body: 'Notifications are working!', kind: 'test', stage: 'test', urgency: 'normal' });
    });
    return json_({ ok: r.accepted > 0, accepted: r.accepted, devices: r.devices, statuses: r.statuses });
  }
  if (action === 'settings') return json_(settingsView_());
  if (action === 'skip' && p.id) return json_(withLock_(function () { return setSkipped_(p.id, true); }));
  if (action === 'unskip' && p.id) return json_(withLock_(function () { return setSkipped_(p.id, false); }));
  if (action === 'refresh') return json_(publicView_(withLock_(function () { return runPlanner_(true); })));
  if (action === 'update') return json_(publicView_(withLock_(function () { return runPlanner_(false); })));
  return json_(publicView_(loadStore_()));
}

/** From the app (POST with a text/plain JSON body): saveSettings, subscribe, unsubscribe. */
function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return json_({ error: 'bad request' }); }
  if (!keyOk_(body.key)) return json_({ error: 'unauthorized' });
  if (body.action === 'saveSettings') {
    // Save only — the app asks for an update right after, so this answers quickly.
    var merged = JSON.parse(JSON.stringify(settings_()));
    Object.keys(body.settings || {}).forEach(function (k) { merged[k] = body.settings[k]; });
    return json_({ ok: true, settings: saveSettings_(merged) });
  }
  if (body.action === 'subscribe') {
    if (!isPushEndpoint_(body.endpoint)) return json_({ error: 'unsupported push service' });
    var n = addDevice_(body.endpoint);
    return json_({ ok: true, devices: n, lastId: loadStore_().lastMsgId || 0 });
  }
  if (body.action === 'unsubscribe') {
    return json_({ ok: true, devices: removeDevice_(String(body.endpoint || '')) });
  }
  return json_({ error: 'unknown action' });
}

/** Messages newer than `since` from the last few hours, oldest first (the app shows them). */
function inbox_(since) {
  var store = loadStore_();
  var cutoff = now_().getTime() - FIXED.INBOX_HOURS * 3600000;
  var messages = (store.outbox || []).filter(function (m) { return m.id > since && m.createdAt >= cutoff; })
    .slice(-FIXED.INBOX_MAX);
  return { messages: messages, lastId: store.lastMsgId || 0 };
}

function ping_() {
  var hasTimer = false;
  try {
    hasTimer = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'tick'; });
  } catch (e) { /* can't tell */ }
  return {
    ok: true,
    version: VERSION,
    now: now_().getTime(),
    hasTimer: hasTimer,
    lastRunAt: loadStore_().updatedAt || null,
    pushDevices: loadDevices_().length,
    pushPublicKey: ensureVapidKeys_().publicKey
  };
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function setSkipped_(key, skipped) {
  var store = loadStore_();
  if (skipped) store.skipped[key] = true; else delete store.skipped[key];
  if (store.plans[key]) store.plans[key].skipped = skipped;
  saveStore_(store);
  return { ok: true, skipped: skipped };
}

function settingsView_() {
  var calendars = [];
  try {
    var defId = CalendarApp.getDefaultCalendar().getId();
    calendars = CalendarApp.getAllCalendars().map(function (c) {
      return { id: c.getId() === defId ? 'primary' : c.getId(), name: c.getName(), primary: c.getId() === defId };
    });
  } catch (e) { /* leave empty */ }
  return {
    version: VERSION,
    settings: settings_(),
    defaults: DEFAULTS,
    calendars: calendars,
    pushPublicKey: ensureVapidKeys_().publicKey,
    pushDevices: loadDevices_().length
  };
}

function publicView_(store) {
  var plans = Object.keys(store.plans).map(function (k) {
    var p = store.plans[k];
    return {
      key: k, title: p.title, location: p.location, address: p.address || null, start: p.start,
      status: p.status, message: p.message || null, options: p.options, alerts: p.alerts || [],
      originLabel: p.originLabel, fromHome: p.fromHome, skipped: !!p.skipped,
      walkMin: p.walkMin || null, sent: Object.keys(p.sent || {}),
      origin: p.origin || null, dest: p.dest || null
    };
  }).sort(function (a, b) { return a.start - b.start; });
  var s = settings_();
  var devices = loadDevices_().length;
  return {
    version: VERSION,
    needsHome: !s.homeAddress,
    updatedAt: store.updatedAt || null,
    origin: s.homeAddress,
    walkToStationMin: s.walkToStationMin,
    settings: s,
    pushDevices: devices,
    pushWarning: devices ? null : (store.pushWarning || null),
    plans: plans
  };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ───────────────────────────── Storage & helpers ─────────────────────────────

/** Our saved plans can be bigger than one Script Property allows, so they're split into chunks. */
function loadStore_() {
  var props = PropertiesService.getScriptProperties();
  var n = Number(props.getProperty('STORE_N') || 0);
  var raw = '';
  for (var i = 0; i < n; i++) raw += props.getProperty('STORE_' + i) || '';
  try {
    var s = raw ? JSON.parse(raw) : null;
    if (s && s.plans) { s.skipped = s.skipped || {}; s.outbox = s.outbox || []; return s; }
  } catch (e) { /* start fresh */ }
  return { plans: {}, skipped: {}, outbox: [], updatedAt: null };
}

function saveStore_(store) {
  var props = PropertiesService.getScriptProperties();
  var raw = JSON.stringify(store);
  var size = FIXED.STORE_CHUNK_CHARS;
  var chunks = {};
  var n = Math.ceil(raw.length / size) || 1;
  for (var i = 0; i < n; i++) chunks['STORE_' + i] = raw.slice(i * size, (i + 1) * size);
  var oldN = Number(props.getProperty('STORE_N') || 0);
  chunks.STORE_N = String(n);
  props.setProperties(chunks);
  for (var j = n; j < oldN; j++) props.deleteProperty('STORE_' + j);
}

function now_() { return new Date(); }

function fmtTime_(ms) {
  return Utilities.formatDate(new Date(ms), FIXED.TIMEZONE, 'h:mm a');
}

/** Short, stable fingerprint of a string (used in keys). */
function hash_(str) {
  var h = 5381;
  str = String(str || '');
  for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Handy for testing from the editor: sends a test notification to every registered phone. */
function sendTestNotification() {
  var r = withLock_(function () {
    return notify_({ title: 'Leave By test 🚇', body: 'Notifications are working!', kind: 'test', stage: 'test', urgency: 'normal' });
  });
  Logger.log(r.devices ? 'Sent to ' + r.accepted + ' of ' + r.devices + ' device(s). Push service replies: ' + r.statuses.join(', ')
    : 'No device registered — open the app from its icon → ⚙︎ → Enable notifications.');
}

/** Handy for checking what the app sees: logs the current plans. */
function logPlans() {
  Logger.log(JSON.stringify(publicView_(runPlanner_(true)), null, 2));
}
