// Leave By — PWA front end. Reads the plan from the Apps Script web app, shows it, and edits settings.
(function () {
  'use strict';

  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  };

  // Official MTA line colors (fallback to Google's color for anything else).
  var MTA_COLORS = {
    '1': '#EE352E', '2': '#EE352E', '3': '#EE352E',
    '4': '#00933C', '5': '#00933C', '6': '#00933C', '6X': '#00933C',
    '7': '#B933AD', '7X': '#B933AD',
    'A': '#0039A6', 'C': '#0039A6', 'E': '#0039A6',
    'B': '#FF6319', 'D': '#FF6319', 'F': '#FF6319', 'FX': '#FF6319', 'M': '#FF6319',
    'G': '#6CBE45', 'J': '#996633', 'Z': '#996633', 'L': '#A7A9AC',
    'N': '#FCCC0A', 'Q': '#FCCC0A', 'R': '#FCCC0A', 'W': '#FCCC0A',
    'S': '#808183', 'GS': '#808183', 'FS': '#808183', 'H': '#808183', 'SI': '#0039A6', 'SIR': '#0039A6'
  };
  var DARK_TEXT = { N: 1, Q: 1, R: 1, W: 1 };
  var NUM_FIELDS = ['walkToStationMin', 'maxWalkMin', 'minEarlyMin', 'maxEarlyMin', 'headsUpMin', 'warningMin', 'quietStartHour', 'quietEndHour'];
  var BOOL_FIELDS = ['chainEvents', 'subwayOnly', 'checkAlerts', 'showEventDetails', 'includeMultiDay'];
  // Must match VERSION in apps-script/Code.gs. If they differ, the app asks you to paste the new script.
  var EXPECTED_BACKEND_VERSION = '2.2.0';
  var STALE_MIN = 20;

  var $ = function (id) { return document.getElementById(id); };
  var state = { data: null, offline: false, loading: false, error: null, serverSettings: null };

  // ── Connection (also accepts a one-tap setup link: #api=…&key=…) ──
  function readHashSetup() {
    if (!location.hash || location.hash.indexOf('api=') < 0) return;
    var params = new URLSearchParams(location.hash.slice(1));
    if (params.get('api')) LS.set('apiUrl', params.get('api'));
    if (params.get('key')) LS.set('apiKey', params.get('key'));
    history.replaceState(null, '', location.pathname + location.search);
  }
  function conn() { return { url: LS.get('apiUrl') || '', key: LS.get('apiKey') || '' }; }
  function isDemo() { return /[?&]demo\b/.test(location.search); }
  function appUrl() { return location.origin + location.pathname; }

  // ── Talking to the script ──
  function checkJson(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json().then(function (j) {
      if (j.error) throw new Error(j.error === 'unauthorized' ? 'Wrong API key' : j.error);
      return j;
    });
  }
  function api(action, extra) {
    var c = conn();
    var q = new URLSearchParams(Object.assign({ action: action, key: c.key, self: c.url, app: appUrl() }, extra || {}));
    return fetch(c.url + (c.url.indexOf('?') >= 0 ? '&' : '?') + q.toString(), { redirect: 'follow' }).then(checkJson);
  }
  function apiPost(body) {
    var c = conn();
    body.key = c.key;
    // text/plain keeps this a "simple" request, which Apps Script accepts from another website.
    return fetch(c.url, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
      .then(checkJson);
  }

  function load(action) {
    if (isDemo()) { state.data = demoData(); render(); return; }
    var c = conn();
    if (!c.url || !c.key) { render(); openSettings(); return; }
    if (state.loading) return;
    state.loading = true;
    $('refreshBtn').classList.add('spin');
    setStatus(action === 'refresh' ? 'Checking trains…' : 'Loading…');
    api(action || 'plans').then(function (d) {
      state.data = d; state.offline = false; state.error = null;
      LS.set('lastData', JSON.stringify(d));
    }).catch(function (e) {
      state.error = e.message;
      state.offline = !navigator.onLine;
    }).then(function () {
      state.loading = false;
      $('refreshBtn').classList.remove('spin');
      render();
    });
  }

  // ── Rendering ──
  function fmt(ms) {
    return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function setStatus(t) { $('status').textContent = t; }

  function bullet(leg) {
    var color = MTA_COLORS[leg.line] || leg.color || '#555';
    var txt = DARK_TEXT[leg.line] ? '#111' : (MTA_COLORS[leg.line] ? '#fff' : (leg.textColor || '#fff'));
    var cls = leg.vehicle === 'SUBWAY' ? 'bullet' : 'bullet bus';
    return '<span class="' + cls + '" style="background:' + esc(color) + ';color:' + esc(txt) + '">' + esc(leg.line) + '</span>';
  }

  function optionHtml(o) {
    var head, detail;
    if (o.type === 'walk') {
      head = '<span class="bullet bus" style="background:#3a4466">🚶</span><strong>Walk ' + o.walkMin + ' min</strong>';
      detail = 'Leave ' + fmt(o.leaveAt) + ' · arrive ~' + o.early + ' min early';
    } else {
      head = o.legs.map(bullet).join('<span class="arrow">›</span>');
      var first = o.legs[0];
      var parts = o.legs.map(function (l) {
        return esc(l.line) + ' ' + fmt(l.departAt) + ' ' + esc(l.from) + ' → ' + esc(l.to) +
          (l.stops ? ' (' + l.stops + ' stops)' : '');
      });
      detail = parts.join('<br>') + '<br>Arrive ' + fmt(o.arriveAt) + ' · ' +
        (o.early >= 0 ? o.early + ' min early' : Math.abs(o.early) + ' min late');
      if (o.delayBufferMin) detail += '<br>⏱ Leave ' + o.delayBufferMin + ' min early — delays on this line';
      else if (o.delayed) detail += ' · ⚠️ delays';
      if (o.nonSubway) detail += ' · includes bus/ferry';
      if (o.outsideWindow) detail += ' · closest available';
      head += '<span class="opt-when">' + (first ? fmt(first.departAt) : '') + '</span>';
    }
    return '<div class="opt' + (o.recommended ? ' best' : '') + '">' +
      (o.recommended ? '<div class="tag">Recommended</div>' : '') +
      '<div class="opt-head">' + head + '</div>' +
      '<div class="opt-detail">' + detail + '</div></div>';
  }

  function countdown(leaveAt) {
    var mins = Math.round((leaveAt - Date.now()) / 60000);
    if (mins < -1) return '<span class="countdown past">left ' + Math.abs(mins) + ' min ago</span>';
    if (mins <= 5) return '<span class="countdown now">' + (mins <= 0 ? 'Leave now' : 'in ' + mins + ' min') + '</span>';
    var label = mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + ' min';
    return '<span class="countdown' + (mins <= 15 ? ' soon' : '') + '">in ' + label + '</span>';
  }

  function planHtml(p) {
    var meta = fmt(p.start) + ' · ' + esc(p.location);
    var keyAttr = ' data-key="' + esc(p.key || '') + '"';
    if (p.skipped) {
      return '<section class="card muted"><p class="ev-title">' + esc(p.title) + '</p><p class="ev-meta">' + meta +
        '</p><p class="ev-meta">Skipped — no alerts. <button class="link" data-act="unskip"' + keyAttr + '>Undo</button></p></section>';
    }
    if (p.status !== 'ok') {
      var why = {
        not_nyc: 'Not in NYC — no alerts',
        no_home: 'Set where you leave from in ⚙︎ Settings',
        vague: 'Location is too general — add a street address in Calendar',
        not_found: "Couldn't find this place — add a street address in Calendar",
        no_route: 'No subway route gets there in time — check Google Maps',
        error: 'Something went wrong planning this one'
      }[p.status] || p.status;
      return '<section class="card muted"><p class="ev-title">' + esc(p.title) + '</p><p class="ev-meta">' + meta +
        '</p><p class="ev-meta">' + esc(why) + '</p></section>';
    }
    var best = p.options[0];
    var alerts = (p.alerts || []).map(function (a) {
      return '<div class="alert">⚠️ <strong>' + esc(a.routes.join('/')) + '</strong>: ' + esc(a.text) + '</div>';
    }).join('');
    var from = p.fromHome ? 'From home' : 'From ' + esc(p.originLabel) + ' (after it ends)';
    return '<section class="card">' +
      '<div class="card-head"><div><p class="ev-title">' + esc(p.title) + '</p>' +
      '<p class="ev-meta">' + meta + '</p></div>' +
      '<button class="link" data-act="skip"' + keyAttr + '>Skip</button></div>' +
      '<div class="leave"><div><div class="leave-label">Leave by</div><div class="leave-time">' + fmt(best.leaveAt) + '</div>' +
      '<div class="from">' + from + '</div></div>' +
      '<span data-leave="' + best.leaveAt + '">' + countdown(best.leaveAt) + '</span></div>' +
      p.options.map(optionHtml).join('') + alerts + '</section>';
  }

  function render() {
    var d = state.data;
    var c = conn();
    var banner = $('banner');
    banner.hidden = true;
    if (!d) {
      $('list').innerHTML = '<div class="empty"><div class="big">🚇</div><p>' +
        (c.url || isDemo() ? esc(state.error || 'No data yet') : 'Open ⚙︎ Settings to connect your calendar script.') + '</p></div>';
      setStatus(state.error ? 'Error: ' + state.error : 'Not connected');
      return;
    }
    var plans = (d.plans || []).filter(function (p) { return p.start > Date.now() - 5 * 60000; })
      .sort(function (a, b) { return a.start - b.start; });
    $('list').innerHTML = plans.length ? plans.map(planHtml).join('')
      : '<div class="empty"><div class="big">☕️</div><p>No in-person events with a location for the rest of today.</p></div>';

    var st = d.updatedAt ? 'Updated ' + fmt(d.updatedAt) : 'Not updated yet';
    if (state.error) st = (state.offline ? 'Offline · ' : 'Error: ' + state.error + ' · ') + st;
    $('status').innerHTML = state.error ? '<span class="offline">' + esc(st) + '</span>' : esc(st);

    var warn = null;
    if (d.needsHome) {
      warn = '👋 Tap ⚙︎ Settings and enter where you usually leave from (e.g. your nearest station).';
    } else if (!isDemo() && d.version !== EXPECTED_BACKEND_VERSION) {
      warn = '⬆️ Your Google script is out of date (' + (d.version || 'old') + ', app expects ' + EXPECTED_BACKEND_VERSION +
        '). Paste the latest Code.gs into script.google.com and choose Deploy → Manage deployments → New version.';
    } else if (!state.error && d.updatedAt && Date.now() - d.updatedAt > STALE_MIN * 60000) {
      warn = '⚠️ No background check for ' + Math.round((Date.now() - d.updatedAt) / 60000) +
        ' min — notifications may have stopped. Open the script and run setup again.';
    }
    if (warn) { banner.hidden = false; banner.textContent = warn; }
    if (d.ntfyTopic) $('topicHint').innerHTML = 'ntfy topic: <code>' + esc(d.ntfyTopic) + '</code>';
  }

  function tickCountdowns() {
    var els = document.querySelectorAll('[data-leave]');
    for (var i = 0; i < els.length; i++) els[i].innerHTML = countdown(Number(els[i].getAttribute('data-leave')));
  }

  // Skip / Undo buttons on cards
  $('list').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn || isDemo()) return;
    btn.disabled = true;
    api(btn.getAttribute('data-act'), { id: btn.getAttribute('data-key') })
      .then(function () { load('plans'); })
      .catch(function (err) { btn.disabled = false; alert(err.message); });
  });

  // ── Settings dialog ──
  (function fillHours() {
    var opts = '';
    for (var h = 0; h < 24; h++) {
      opts += '<option value="' + h + '">' + (h % 12 || 12) + ' ' + (h < 12 ? 'AM' : 'PM') + '</option>';
    }
    $('s_quietStartHour').innerHTML = opts;
    $('s_quietEndHour').innerHTML = opts;
  })();

  function setTripFieldsEnabled(on) {
    ['tripSettings', 'notifSettings', 'calSettings'].forEach(function (id) { $(id).disabled = !on; });
  }

  function fillSettings(view) {
    state.serverSettings = view;
    var s = view.settings;
    $('s_homeAddress').value = s.homeAddress;
    NUM_FIELDS.forEach(function (k) { $('s_' + k).value = s[k]; });
    BOOL_FIELDS.forEach(function (k) { $('s_' + k).checked = !!s[k]; });
    var cals = view.calendars || [];
    $('calList').innerHTML = cals.length ? cals.map(function (cal) {
      var on = s.calendarIds.indexOf(cal.id) >= 0;
      return '<label class="check"><input type="checkbox" data-cal="' + esc(cal.id) + '"' + (on ? ' checked' : '') + '> ' +
        esc(cal.name) + (cal.primary ? ' <span class="hint">(main)</span>' : '') + '</label>';
    }).join('') : 'No calendars found.';
    if (view.ntfyTopic) $('topicHint').innerHTML = 'ntfy topic: <code>' + esc(view.ntfyTopic) + '</code>';
    setTripFieldsEnabled(true);
  }

  function readSettings() {
    var s = { homeAddress: $('s_homeAddress').value.trim() };
    NUM_FIELDS.forEach(function (k) { s[k] = Number($('s_' + k).value); });
    BOOL_FIELDS.forEach(function (k) { s[k] = $('s_' + k).checked; });
    var boxes = document.querySelectorAll('[data-cal]');
    if (boxes.length) {
      s.calendarIds = Array.prototype.filter.call(boxes, function (b) { return b.checked; })
        .map(function (b) { return b.getAttribute('data-cal'); });
      if (!s.calendarIds.length) s.calendarIds = ['primary'];
    }
    return s;
  }

  function loadServerSettings() {
    if (isDemo()) { fillSettings(demoSettings()); return; }
    var c = conn();
    if (!c.url || !c.key) { setTripFieldsEnabled(false); $('connection').open = true; return; }
    $('saveResult').textContent = 'Loading settings…';
    api('settings').then(function (v) { fillSettings(v); $('saveResult').textContent = ''; })
      .catch(function (e) { setTripFieldsEnabled(false); $('connection').open = true; $('saveResult').textContent = '❌ ' + e.message; });
  }

  function openSettings() {
    var c = conn();
    $('apiUrl').value = c.url;
    $('apiKey').value = c.key;
    $('testResult').textContent = '';
    $('saveResult').textContent = '';
    if (!$('settings').open) { $('settings').showModal(); $('settings').scrollTop = 0; }
    loadServerSettings();
  }

  function saveConnection() {
    LS.set('apiUrl', $('apiUrl').value.trim());
    LS.set('apiKey', $('apiKey').value.trim());
  }

  $('settingsBtn').addEventListener('click', openSettings);
  $('connectBtn').addEventListener('click', function () {
    saveConnection();
    state.data = null;
    loadServerSettings();
    load('plans');
  });
  $('settingsForm').addEventListener('submit', function (e) {
    if (e.submitter && e.submitter.value !== 'save') return; // Close button
    e.preventDefault();
    saveConnection();
    if (isDemo() || !state.serverSettings) { $('settings').close(); load('plans'); return; }
    $('saveBtn').disabled = true;
    $('saveResult').textContent = 'Saving and re-planning your trips…';
    apiPost({ action: 'saveSettings', settings: readSettings() }).then(function (v) {
      if (v.plans) { state.data = v.plans; LS.set('lastData', JSON.stringify(v.plans)); state.error = null; }
      fillSettings(v);
      $('settings').close();
      render();
    }).catch(function (err) {
      $('saveResult').textContent = '❌ ' + err.message;
    }).then(function () { $('saveBtn').disabled = false; });
  });
  $('testBtn').addEventListener('click', function () {
    if (isDemo()) { $('testResult').textContent = 'Demo mode — nothing sent.'; return; }
    saveConnection();
    $('testResult').textContent = 'Sending…';
    api('test').then(function (r) {
      $('testResult').textContent = r.ok ? '✅ Sent! Check the ntfy app.' : '⚠️ Script ran but ntfy failed.';
    }).catch(function (e) { $('testResult').textContent = '❌ ' + e.message; });
  });
  $('refreshBtn').addEventListener('click', function () { load('refresh'); });

  // ── Demo data (open the app with ?demo to preview) ──
  function demoSettings() {
    return {
      settings: { homeAddress: 'Canal St Station, New York, NY', walkToStationMin: 5, maxWalkMin: 20, minEarlyMin: 0, maxEarlyMin: 10,
        headsUpMin: 90, warningMin: 15, quietStartHour: 22, quietEndHour: 7, chainEvents: true, subwayOnly: true, checkAlerts: true, showEventDetails: true, includeMultiDay: false,
        calendarIds: ['primary'] },
      calendars: [{ id: 'primary', name: 'Me', primary: true }, { id: 'family', name: 'Family' }],
      ntfyTopic: 'leaveby-demo'
    };
  }
  function demoData() {
    var now = Date.now(), m = 60000;
    var start1 = Math.ceil((now + 95 * m) / (15 * m)) * 15 * m;
    var start2 = start1 + 150 * m;
    var leg = function (line, dep, from, to, stops, vehicle) {
      return { line: line, vehicle: vehicle || 'SUBWAY', from: from, to: to, departAt: dep, stops: stops, headsign: '' };
    };
    return {
      updatedAt: now, version: EXPECTED_BACKEND_VERSION, origin: 'Canal St Station, New York, NY', ntfyTopic: 'leaveby-demo',
      plans: [
        { key: 'a', title: 'Dinner w/ Sam', location: 'Carbone, 181 Thompson St, New York, NY', start: start1, status: 'ok', fromHome: true,
          alerts: [],
          options: [
            { type: 'transit', recommended: true, leaveAt: start1 - 33 * m, arriveAt: start1 - 6 * m, early: 6,
              legs: [leg('C', start1 - 28 * m, 'Canal St', 'Spring St', 3)] },
            { type: 'transit', leaveAt: start1 - 35 * m, arriveAt: start1 - 8 * m, early: 8, delayed: true,
              legs: [leg('A', start1 - 30 * m, 'Canal St', 'Spring St', 3)] },
            { type: 'transit', leaveAt: start1 - 40 * m, arriveAt: start1 - 9 * m, early: 9,
              legs: [leg('2', start1 - 35 * m, 'Canal St', 'Chambers St', 2), leg('1', start1 - 28 * m, 'Chambers St', 'Houston St', 3)] }
          ] },
        { key: 'b', title: 'Drinks in Astoria', location: 'Bohemian Hall, 29-19 24th Ave, Queens', start: start2, status: 'ok',
          fromHome: false, originLabel: 'Dinner w/ Sam', alerts: [{ routes: ['N'], text: 'Some northbound N trains are running with delays.' }],
          options: [{ type: 'transit', recommended: true, leaveAt: start2 - 55 * m, arriveAt: start2 - 4 * m, early: 4, delayBufferMin: 5, delayed: true,
            legs: [leg('R', start2 - 50 * m, 'Prince St', '57 St-7 Av', 8), leg('N', start2 - 28 * m, '57 St-7 Av', 'Astoria Blvd', 7)] }] },
        { key: 'c', title: 'Coffee w/ Priya', location: 'Black Fox Coffee, 70 Pine St', start: start2 + 30 * m, status: 'ok', skipped: true, options: [], alerts: [] },
        { key: 'd', title: 'Housewarming', location: 'Brooklyn', start: start2 + 60 * m, status: 'vague', options: [], alerts: [] },
        { key: 'e', title: 'Team offsite', location: 'Hoboken, NJ', start: start2 + 120 * m, status: 'not_nyc', options: [], alerts: [] }
      ]
    };
  }

  // ── Boot ──
  readHashSetup();
  if (!isDemo()) { try { state.data = JSON.parse(LS.get('lastData') || 'null'); } catch (e) { /* ignore */ } }
  render();
  load('plans');
  setInterval(tickCountdowns, 30000);
  setInterval(function () { if (!document.hidden) load('plans'); }, 5 * 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load('plans'); });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
})();
