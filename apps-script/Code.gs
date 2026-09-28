/**
 * Leave By — Google Apps Script backend.
 *
 * What this does (plain English):
 *  - Every 5 minutes, look at today's calendar events that have a location.
 *  - For NYC places, ask Google Maps for subway routes that get you there 0–10 minutes early
 *    (from home, or from your previous event if you'll be coming from there).
 *  - Send phone notifications via the ntfy app: heads-up, 15-minute warning, leave now.
 *  - Serve the plan (and your settings) to the Leave By app.
 *
 * First-time setup: run setup() once from the Apps Script editor. After that, change
 * settings from the app's ⚙️ screen — no need to edit this file.
 *
 * PRIVACY: this file lives in a public GitHub repo. Never put personal details
 * (home address, keys, topic names) in it — they belong in the app's Settings,
 * which are stored privately in this script's Script Properties.
 */

var VERSION = '2.2.1'; // bump together with EXPECTED_BACKEND_VERSION in web/app.js

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
  appUrl: 'https://jspenc111-stack.github.io/train-time/' // your app's link, e.g. https://USERNAME.github.io/train-time/ (the app also fills this in)
};

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
  NTFY_SERVER: 'https://ntfy.sh',
  STORE_CHUNK_CHARS: 2500   // Script Properties allow ~9 KB per value; split our data into safe chunks
};

var MTA_ALERTS_URL = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json';
var NYC_BOUNDS = { south: 40.4774, west: -74.2591, north: 40.9176, east: -73.7004 };
var NYC_BOROUGHS = ['manhattan', 'brooklyn', 'queens', 'bronx', 'the bronx', 'staten island'];
var NYC_COUNTIES = ['new york county', 'kings county', 'queens county', 'bronx county', 'richmond county'];
var VIRTUAL_RE = /(https?:\/\/|zoom\.us|meet\.google|teams\.microsoft|webex|\bvirtual\b|\bonline\b|\bzoom\b|\bgoogle meet\b|\bphone call\b|\bfacetime\b)/i;
var VAGUE_TYPES = ['country', 'administrative_area_level_1', 'administrative_area_level_2', 'locality', 'sublocality', 'sublocality_level_1', 'postal_code', 'colloquial_area'];
var SKIP_EVENT_TYPES = ['WORKING_LOCATION', 'OUT_OF_OFFICE', 'FOCUS_TIME', 'BIRTHDAY'];
var DELAY_RE = /delay|suspend|not running|no \w+ (?:train )?service|slower|running with|express to|bypass/i;

// ───────────────────────────── Setup ─────────────────────────────

/** Run once. Creates secrets and the 5-minute timer. Safe to run again. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('API_KEY')) props.setProperty('API_KEY', Utilities.getUuid().replace(/-/g, ''));
  if (!props.getProperty('NTFY_TOPIC')) props.setProperty('NTFY_TOPIC', 'leaveby-' + Utilities.getUuid().replace(/-/g, '').slice(0, 16));

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();

  tick();
  Logger.log('✅ Setup done. Next: Deploy → New deployment → Web app, then run getAppLink.');
  Logger.log('Then open the app and set where you leave from in ⚙︎ Settings.');
  Logger.log('ntfy topic (subscribe in the ntfy app): ' + props.getProperty('NTFY_TOPIC'));
}

/**
 * Run AFTER deploying as a web app.
 * Logs a one-tap link that opens the app already connected to this script.
 */
function getAppLink() {
  var props = PropertiesService.getScriptProperties();
  var url = ScriptApp.getService().getUrl();
  if (!url) { Logger.log('Deploy as a web app first (Deploy → New deployment → Web app).'); return; }
  // Run from the editor, Google often gives the /dev test link, which only works inside the editor.
  // Fall back to the /exec link the app reported earlier, if there is one.
  if (isExecUrl_(url)) props.setProperty('WEB_APP_URL', url);
  else if (isExecUrl_(props.getProperty('WEB_APP_URL'))) url = props.getProperty('WEB_APP_URL');
  else url = '';
  var base = appUrl_() || 'https://YOUR-USERNAME.github.io/train-time/';
  var key = props.getProperty('API_KEY');
  Logger.log('1) Subscribe to this topic in the ntfy app: ' + props.getProperty('NTFY_TOPIC'));
  if (url) {
    Logger.log('2) Open this link on your phone:\n' + base + '#api=' + encodeURIComponent(url) + '&key=' + key);
    return;
  }
  Logger.log('2) Tap Deploy → Manage deployments and copy the Web app URL (it ends in /exec).');
  Logger.log('3) Open this link on your phone, then tap ⚙︎ → Connection, paste that URL into "Apps Script web app URL" and tap Connect:\n' + base + '#key=' + key);
}

function isExecUrl_(url) {
  return /^https:\/\/script\.google(usercontent)?\.com\/.*\/exec$/.test(url || '');
}

/**
 * If your app link or ntfy topic ever leaks, run this: it makes a new API key and topic.
 * Then run getAppLink again, re-open the app with the new link, and re-subscribe in ntfy.
 */
function resetSecrets() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('API_KEY', Utilities.getUuid().replace(/-/g, ''));
  props.setProperty('NTFY_TOPIC', 'leaveby-' + Utilities.getUuid().replace(/-/g, '').slice(0, 16));
  Logger.log('🔑 New key and topic created. Now run getAppLink.');
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
    if (cached && !forceReplan && !needsReplan_(cached, origin, nowMs)) {
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
    }
    plan.key = key;
    plan.skipped = !!skipped[key];
    plans[key] = plan;
    if (!plan.skipped) maybeNotify_(plan, now, s);
  });

  store.plans = plans;      // drops events that are over / removed
  store.skipped = skipped;  // forget skips for events that are gone
  store.updatedAt = nowMs;
  saveStore_(store);
  return store;
}

/** How long a saved plan stays good before we ask Google Maps again. */
function needsReplan_(plan, origin, nowMs) {
  if (plan.originKey !== origin.key) return true;                    // coming from somewhere else now
  if (plan.status === 'not_nyc' || plan.status === 'vague' || plan.status === 'not_found') return false; // same place → same answer
  if (plan.sent && plan.sent.now) return false;                     // you've left; keep it stable
  var age = (nowMs - plan.plannedAt) / 60000;
  if (plan.status !== 'ok') return age >= 30;
  var minsToLeave = (plan.options[0].leaveAt - nowMs) / 60000;
  return age >= (minsToLeave > 180 ? 60 : 15);
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
  return { key: 'event:' + hash_(geo.address), address: geo.address, label: prev.title, walkMin: 0, fromHome: false, departAfter: prev.end.getTime() };
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

/** Geocode with a 6-hour cache. Returns {address, isNyc, vague} or null. */
function geocode_(location) {
  var cache = CacheService.getScriptCache();
  var ck = 'geo:' + hash_(location);
  var hit = cache.get(ck);
  if (hit) return hit === 'null' ? null : JSON.parse(hit);

  var res = Maps.newGeocoder()
    .setBounds(NYC_BOUNDS.south, NYC_BOUNDS.west, NYC_BOUNDS.north, NYC_BOUNDS.east)
    .setRegion('us')
    .geocode(location);
  var out = null;
  if (res && res.status === 'OK' && res.results && res.results.length) {
    var r = res.results[0];
    out = { address: r.formatted_address, isNyc: isNyc_(r), vague: isVague_(r) };
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

function maybeNotify_(plan, now, s) {
  var nowMs = now.getTime();
  plan.sent = plan.sent || {};

  // Can't plan this one: tell you once, in time to fix the location.
  if (PROBLEM_STATUSES.indexOf(plan.status) >= 0) {
    if (!plan.sent.problem && plan.start - nowMs <= (s.headsUpMin + 60) * 60000) {
      if (sendNtfy_(buildProblemMessage_(plan, now, s), plan)) plan.sent.problem = nowMs;
    }
    return;
  }

  var stage = dueStage_(plan, nowMs, s);
  var leaveAt = plan.options.length ? plan.options[0].leaveAt : null;
  if (stage) {
    if (sendNtfy_(buildMessage_(plan, stage, now, s), plan)) {
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
    if (sendNtfy_(msg, plan)) {
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

function buildMessage_(plan, stage, now, s) {
  var best = plan.options[0];
  var t = fmtTime_;
  var tag = best.type === 'walk' ? 'walking' : 'metro';
  var d = s.showEventDetails;
  var name = d ? plan.title : 'your event';
  var at = d ? ' @ ' + shortPlace_(plan) : '';
  var from = plan.fromHome ? '' : (d ? 'From ' + plan.originLabel + ' · ' : 'From your previous event · ');
  var bestText = describeOption_(best);
  var title, body, priority, tags;

  if (stage === 'headsup') {
    title = 'Leave ' + t(best.leaveAt) + ' → ' + name;
    var alts = plan.options.slice(1, 3).map(function (o) { return describeOption_(o, true); });
    body = t(plan.start) + at + '\n' + from + bestText +
      (alts.length ? '\nOr: ' + alts.join(' · ') : '');
    priority = isQuiet_(now, s) ? 2 : 3; tags = [tag];
  } else if (stage === 'warning') {
    title = 'Leave in ' + Math.max(1, Math.round((best.leaveAt - now.getTime()) / 60000)) + ' min (' + t(best.leaveAt) + ')';
    body = name + ' at ' + t(plan.start) + '\n' + from + bestText;
    priority = 4; tags = [tag, 'hourglass_flowing_sand'];
  } else if (stage === 'change') {
    title = 'Change: leave ' + t(best.leaveAt) + ' (was ' + t(plan.notifiedLeaveAt) + ')';
    body = name + ' at ' + t(plan.start) + '\n' + from + bestText;
    priority = 4; tags = [tag, 'arrows_counterclockwise'];
  } else {
    title = 'Leave now!' + (d ? ' ' + plan.title : '');
    body = bestText + '\nStarts ' + t(plan.start) + at;
    priority = 5; tags = [tag, 'rotating_light'];
  }
  if (best.delayBufferMin) body += '\n⏱ Leaving ' + best.delayBufferMin + ' min early because of delays.';
  if (plan.alerts && plan.alerts.length) {
    body += '\n⚠️ ' + plan.alerts.map(function (a) { return a.routes.join('/') + ': ' + a.text; }).join('\n⚠️ ');
  }
  if (best.outsideWindow) body += '\n(No train lands ' + s.minEarlyMin + '–' + s.maxEarlyMin + ' min early — this is the closest.)';
  if (best.nonSubway) body += '\n(No subway-only route — includes bus/ferry.)';
  return { title: title, message: body, priority: priority, tags: tags, skippable: true };
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
    message: 'Leave By ' + why + '.' + (plan.status === 'vague' || plan.status === 'not_found'
      ? ' Add a street address to the event and it will update within 5 minutes.' : ' Check Google Maps for this one.'),
    priority: isQuiet_(now, s) ? 2 : 3,
    tags: ['warning'],
    skippable: false
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

function sendNtfy_(msg, plan) {
  var props = PropertiesService.getScriptProperties();
  var topic = props.getProperty('NTFY_TOPIC');
  if (!topic) return false;
  var payload = { topic: topic, title: msg.title, message: msg.message, priority: msg.priority, tags: msg.tags };
  var actions = [];
  var app = appUrl_();
  if (app) {
    payload.click = app;
    actions.push({ action: 'view', label: 'Open', url: app });
  }
  var webApp = props.getProperty('WEB_APP_URL');
  if (msg.skippable && plan && plan.key && webApp) {
    actions.push({
      action: 'http', label: 'Skip this event', method: 'GET', clear: true,
      url: webApp + '?action=skip&id=' + encodeURIComponent(plan.key) + '&t=' + skipToken_(plan.key)
    });
  }
  if (actions.length) payload.actions = actions;
  try {
    var resp = UrlFetchApp.fetch(FIXED.NTFY_SERVER, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    return resp.getResponseCode() < 300;
  } catch (e) {
    return false;
  }
}

/** A per-event code so the notification's Skip button works without exposing your API key. */
function skipToken_(planKey) {
  var sig = Utilities.computeHmacSha256Signature(planKey, PropertiesService.getScriptProperties().getProperty('API_KEY'));
  return sig.slice(0, 12).map(function (b) { return ((b + 256) % 256).toString(16); })
    .map(function (h) { return h.length < 2 ? '0' + h : h; }).join('');
}

// ───────────────────────────── Web API for the app ─────────────────────────────

function doGet(e) {
  var p = (e && e.parameter) || {};
  var props = PropertiesService.getScriptProperties();
  var keyOk = !!p.key && p.key === props.getProperty('API_KEY');
  var action = p.action || 'plans';

  // Skip from a notification button: authorised by the per-event code instead of the API key.
  if (action === 'skip' && p.id && (keyOk || (p.t && p.t === skipToken_(p.id)))) {
    return json_(withLock_(function () { return setSkipped_(p.id, true); }));
  }
  if (!keyOk) return json_({ error: 'unauthorized' });

  // The app tells us its own links, so notification buttons can open it and skip events.
  if (isExecUrl_(p.self) && props.getProperty('WEB_APP_URL') !== p.self) {
    props.setProperty('WEB_APP_URL', p.self);
  }
  if (p.app && /^https:\/\//.test(p.app) && settings_().appUrl !== p.app) {
    var cur = settings_();
    cur.appUrl = p.app;
    saveSettings_(cur);
  }

  if (action === 'test') {
    var ok = sendNtfy_({ title: 'Leave By test 🚇', message: 'Notifications are working!', priority: 3, tags: ['white_check_mark'] });
    return json_({ ok: ok });
  }
  if (action === 'settings') return json_(settingsView_());
  if (action === 'unskip' && p.id) return json_(withLock_(function () { return setSkipped_(p.id, false); }));
  if (action === 'refresh') return json_(publicView_(withLock_(function () { return runPlanner_(true); })));
  return json_(publicView_(loadStore_()));
}

/** Saving settings from the app (POST with a text/plain JSON body: {key, settings}). */
function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return json_({ error: 'bad request' }); }
  if (!body.key || body.key !== PropertiesService.getScriptProperties().getProperty('API_KEY')) return json_({ error: 'unauthorized' });
  if (body.action !== 'saveSettings') return json_({ error: 'unknown action' });
  var merged = settings_();
  Object.keys(body.settings || {}).forEach(function (k) { merged[k] = body.settings[k]; });
  saveSettings_(merged);
  var store = withLock_(function () { return runPlanner_(true); });
  var view = settingsView_();
  view.plans = publicView_(store);
  return json_(view);
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
    ntfyTopic: PropertiesService.getScriptProperties().getProperty('NTFY_TOPIC')
  };
}

function publicView_(store) {
  var plans = Object.keys(store.plans).map(function (k) {
    var p = store.plans[k];
    return {
      key: k, title: p.title, location: p.location, address: p.address || null, start: p.start,
      status: p.status, message: p.message || null, options: p.options, alerts: p.alerts || [],
      originLabel: p.originLabel, fromHome: p.fromHome, skipped: !!p.skipped,
      walkMin: p.walkMin || null, sent: Object.keys(p.sent || {})
    };
  }).sort(function (a, b) { return a.start - b.start; });
  var s = settings_();
  return {
    version: VERSION,
    needsHome: !s.homeAddress,
    updatedAt: store.updatedAt || null,
    origin: s.homeAddress,
    walkToStationMin: s.walkToStationMin,
    ntfyTopic: PropertiesService.getScriptProperties().getProperty('NTFY_TOPIC'),
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
    if (s && s.plans) { s.skipped = s.skipped || {}; return s; }
  } catch (e) { /* start fresh */ }
  return { plans: {}, skipped: {}, updatedAt: null };
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

/** Handy for testing from the editor: sends a test notification. */
function sendTestNotification() {
  sendNtfy_({ title: 'Leave By test 🚇', message: 'Notifications are working!', priority: 3, tags: ['white_check_mark'] });
}

/** Handy for checking what the app sees: logs the current plans. */
function logPlans() {
  Logger.log(JSON.stringify(publicView_(runPlanner_(true)), null, 2));
}
