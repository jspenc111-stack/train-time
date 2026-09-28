// Leave By — PWA front end. Reads the plan from the Apps Script web app, shows it, edits settings,
// and turns on notifications for this phone.
(function () {
  'use strict';

  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  };
  var KV = window.LeaveByKV;
  var Links = window.LeaveByLinks;

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
  var EXPECTED_BACKEND_VERSION = '2.3.0';
  var STALE_MIN = 20;
  var CALENDARS_MAX_AGE = 24 * 3600000;
  var EXEC_RE = /^https:\/\/script\.google\.com\/(macros|a\/macros\/[^\/]+)\/s\/[\w-]+\/exec$/;
  var DEV_TEXT = 'This is a test link — it only works when you\'re signed in on a computer. Use the /exec link.';
  var BLOCKED_TEXT = 'Allow notifications for Leave By in Android Settings → Apps → Leave By → Notifications.';
  var CHROME_SAYS_INSTALLED = 'Chrome says Leave By is installed. Look for it in your app drawer (swipe up) and add it to your home screen. ' +
    'If it won\'t open, uninstall it in Android Settings → Apps → Leave By, then reinstall from Chrome\'s ⋮ menu → Add to Home screen.';

  var $ = function (id) { return document.getElementById(id); };
  var state = { data: null, loading: false, pending: null, error: null, serverSettings: null, pushPublicKey: null };

  // ── Connection (also accepts a one-tap setup link: #api=…&key=…) ──
  function readHashSetup() {
    if (!location.hash || !/(api|key)=/.test(location.hash)) return;
    var params = new URLSearchParams(location.hash.slice(1));
    if (params.get('api') && !isDevUrl(params.get('api'))) LS.set('apiUrl', params.get('api'));
    if (params.get('key')) LS.set('apiKey', params.get('key'));
    history.replaceState(null, '', location.pathname + location.search);
  }
  function conn() { return { url: LS.get('apiUrl') || '', key: LS.get('apiKey') || '' }; }
  // The service worker can't read localStorage, so the connection is copied to IndexedDB too.
  function syncConn() {
    if (!KV || isDemo()) return;
    KV.set('conn', conn()).catch(function () { /* private mode etc. */ });
  }
  function isDemo() { return /[?&]demo\b/.test(location.search); }
  function appUrl() { return location.origin + location.pathname; }
  function isDevUrl(u) { return /\/dev\/?$/.test(u || ''); }
  function urlProblem(u) {
    if (!u) return '';
    if (isDevUrl(u)) return DEV_TEXT;
    if (!EXEC_RE.test(u)) return 'This doesn\'t look like an Apps Script web app link. It should look like https://script.google.com/macros/s/…/exec';
    return '';
  }

  // ── Talking to the script ──
  var ERR_TEXT = {
    dev: DEV_TEXT,
    network: 'Can\'t reach your Google script (no response).',
    offline: 'You\'re offline.',
    html: 'Your Google script sent a web page instead of data.',
    key: 'Wrong API key.'
  };
  function connErr(kind, status, detail) {
    var e = new Error(kind === 'http' ? 'Can\'t reach your Google script (HTTP ' + status + ').'
      : kind === 'script' ? 'Script error: ' + detail : ERR_TEXT[kind]);
    e.kind = kind;
    e.status = status || 0;
    return e;
  }
  function send(url, opts) {
    if (isDevUrl(conn().url)) return Promise.reject(connErr('dev'));
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw connErr('http', r.status);
      return r.text().then(function (t) {
        var j;
        try { j = JSON.parse(t); } catch (e) { throw connErr('html'); }
        if (j.error === 'unauthorized') throw connErr('key');
        if (j.error) throw connErr('script', 0, j.error);
        return j;
      });
    }, function () {
      throw connErr(navigator.onLine === false ? 'offline' : 'network');
    });
  }
  function api(action, extra) {
    var c = conn();
    var q = new URLSearchParams(Object.assign({ action: action, key: c.key, app: appUrl() }, extra || {}));
    return send(c.url + (c.url.indexOf('?') >= 0 ? '&' : '?') + q.toString(), { redirect: 'follow' });
  }
  function apiPost(body) {
    body.key = conn().key;
    // text/plain keeps this a "simple" request, which Apps Script accepts from another website.
    return send(conn().url, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
  }

  var STATUS_TEXT = { refresh: 'Checking trains…', update: 'Updating trips…' };
  function load(action) {
    action = action || 'plans';
    if (isDemo()) { state.data = demoData(); render(); return; }
    var c = conn();
    if (!c.url || !c.key) { render(); openSettings(); return; }
    if (state.loading) { if (action !== 'plans') state.pending = action; return; }
    state.loading = true;
    $('refreshBtn').classList.add('spin');
    setStatus(STATUS_TEXT[action] || 'Loading…');
    api(action).then(function (d) {
      state.data = d; state.error = null;
      LS.set('lastData', JSON.stringify(d));
      if (d.settings) updateCache({ settings: d.settings });
    }).catch(function (e) {
      state.error = e;
    }).then(function () {
      state.loading = false;
      $('refreshBtn').classList.remove('spin');
      render();
      if (state.pending) { var next = state.pending; state.pending = null; load(next); }
    });
  }

  // ── Settings cache (so ⚙︎ opens instantly) ──
  function readCache() { try { return JSON.parse(LS.get('settingsCache') || 'null'); } catch (e) { return null; } }
  function updateCache(part) { LS.set('settingsCache', JSON.stringify(Object.assign(readCache() || {}, part))); }
  function directionsApp() {
    var s = (state.data && state.data.settings) || (readCache() || {}).settings || {};
    return s.directionsApp === 'citymapper' ? 'citymapper' : 'google';
  }

  // ── Rendering ──
  var TZ = 'America/New_York';
  function fmt(ms) {
    return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
  }
  function nyDay(ms) { return new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ }); }
  /** "7:00 PM" today, "Tue 7:00 PM" on another day. */
  function dayTime(ms) {
    return nyDay(ms) === nyDay(Date.now()) ? fmt(ms)
      : new Date(ms).toLocaleDateString('en-US', { weekday: 'short', timeZone: TZ }) + ' ' + fmt(ms);
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

  function optionHtml(o, p, app) {
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
    var url = Links ? Links.directionsUrl(app, p, o) : null;
    var inner = (o.recommended ? '<div class="tag">Recommended</div>' : '') +
      '<div class="opt-head">' + head + '</div>' +
      '<div class="opt-detail">' + detail + '</div>' +
      (url ? '<div class="dir-hint">Directions ›</div>' : '');
    var cls = 'opt' + (o.recommended ? ' best' : '');
    return url
      ? '<a class="' + cls + '" href="' + esc(url) + '" target="_blank" rel="noopener">' + inner + '</a>'
      : '<div class="' + cls + '">' + inner + '</div>';
  }

  function countdown(leaveAt) {
    var mins = Math.round((leaveAt - Date.now()) / 60000);
    if (mins < -1) return '<span class="countdown past">left ' + Math.abs(mins) + ' min ago</span>';
    if (mins <= 5) return '<span class="countdown now">' + (mins <= 0 ? 'Leave now' : 'in ' + mins + ' min') + '</span>';
    var label = mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + ' min';
    return '<span class="countdown' + (mins <= 15 ? ' soon' : '') + '">in ' + label + '</span>';
  }

  function cardHead(p, button) {
    return '<div class="card-head"><div class="head-main"><span class="time-chip">' + esc(dayTime(p.start)) + '</span>' +
      '<span class="ev-title">' + esc(p.title) + '</span></div>' + (button || '') + '</div>' +
      '<p class="ev-meta">' + esc(p.location) + '</p>';
  }

  function planHtml(p, app) {
    var keyAttr = ' data-key="' + esc(p.key || '') + '"';
    if (p.skipped) {
      return '<section class="card muted">' + cardHead(p) +
        '<p class="ev-meta">Skipped — no alerts. <button class="link" data-act="unskip"' + keyAttr + '>Undo</button></p></section>';
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
      return '<section class="card muted">' + cardHead(p) + '<p class="ev-meta">' + esc(why) + '</p></section>';
    }
    var best = p.options[0];
    var alerts = (p.alerts || []).map(function (a) {
      return '<div class="alert">⚠️ <strong>' + esc(a.routes.join('/')) + '</strong>: ' + esc(a.text) + '</div>';
    }).join('');
    var from = p.fromHome ? 'From home' : 'From ' + esc(p.originLabel) + ' (after it ends)';
    return '<section class="card">' +
      cardHead(p, '<button class="link" data-act="skip"' + keyAttr + '>Skip</button>') +
      '<div class="leave"><div class="times">' +
      '<div><div class="leave-label">Leave by</div><div class="leave-time">' + fmt(best.leaveAt) + '</div></div>' +
      '<div><div class="leave-label">Starts</div><div class="start-time">' + fmt(p.start) + '</div></div></div>' +
      '<span data-leave="' + best.leaveAt + '">' + countdown(best.leaveAt) + '</span></div>' +
      '<div class="from">' + from + '</div>' +
      p.options.map(function (o) { return optionHtml(o, p, app); }).join('') + alerts + '</section>';
  }

  var FIX_HTML = '<details class="fix"><summary>How to fix</summary><ul>' +
    '<li><strong>HTTP 404 or no response:</strong> the web app link is out of date, the deployment was archived, or it\'s a <code>/dev</code> test link. ' +
    'In script.google.com tap <strong>Deploy → Manage deployments</strong>, copy the <strong>Web app</strong> URL ending in <code>/exec</code>, and paste it into ⚙︎ → Connection.</li>' +
    '<li><strong>A web page instead of data:</strong> the deployment\'s <strong>Who has access</strong> must be <strong>Anyone</strong>.</li>' +
    '<li><strong>Wrong API key:</strong> reopen the setup link from <code>getAppLink</code>.</li>' +
    '</ul><p>⚙︎ → Connection → <strong>Check connection</strong> tests each step.</p></details>';

  function banners(d) {
    var out = [];
    var e = state.error;
    var saved = d && d.updatedAt ? ' Showing saved plans from ' + fmt(d.updatedAt) + '.' : '';
    if (e && e.kind === 'offline') out.push({ cls: 'info', html: '📴 You\'re offline.' + esc(saved) });
    else if (e) out.push({ cls: 'error', html: '<p>' + esc(e.message + saved) + '</p>' + FIX_HTML });
    if (!d) return out;
    if (d.needsHome) {
      out.push({ html: '👋 Tap ⚙︎ Settings and enter where you usually leave from (e.g. your nearest station).' });
    } else if (!isDemo() && d.version !== EXPECTED_BACKEND_VERSION) {
      out.push({ html: esc('⬆️ Your Google script is out of date (' + (d.version || 'old') + ', app expects ' + EXPECTED_BACKEND_VERSION +
        '). Paste the latest Code.gs into script.google.com, run setup, and choose Deploy → Manage deployments → New version.') });
    }
    if (d.updatedAt && Date.now() - d.updatedAt > STALE_MIN * 60000) {
      out.push({ html: esc('⚠️ No background check for ' + Math.round((Date.now() - d.updatedAt) / 60000) +
        ' min — notifications may have stopped. Open the script and run setup again.') });
    }
    if (!isDemo() && pushSupported() && (d.pushWarning === 'no_device' || Notification.permission !== 'granted')) {
      out.push({ html: '🔔 Notifications are off on this phone — tap to turn on.', act: 'phone' });
    }
    return out;
  }

  function render() {
    var d = state.data;
    var c = conn();
    $('banners').innerHTML = banners(d).map(function (b) {
      return '<div class="banner' + (b.cls ? ' ' + b.cls : '') + '"' + (b.act ? ' role="button" tabindex="0" data-banner="' + b.act + '"' : '') + '>' + b.html + '</div>';
    }).join('');
    if (!d) {
      $('list').innerHTML = '<div class="empty"><div class="big">🚇</div><p>' +
        (c.url || isDemo() ? (state.error ? 'No saved plans yet.' : 'No data yet') : 'Open ⚙︎ Settings to connect your calendar script.') + '</p></div>';
      setStatus(state.error ? 'Not connected' : (c.url ? 'Loading…' : 'Not connected'));
      return;
    }
    var app = directionsApp();
    var plans = (d.plans || []).filter(function (p) { return p.start > Date.now() - 5 * 60000; })
      .sort(function (a, b) { return a.start - b.start; });
    $('list').innerHTML = plans.length ? plans.map(function (p) { return planHtml(p, app); }).join('')
      : '<div class="empty"><div class="big">☕️</div><p>No in-person events with a location for the rest of today.</p></div>';

    var st = d.updatedAt ? 'Updated ' + fmt(d.updatedAt) : 'Not updated yet';
    if (state.error) st = (state.error.kind === 'offline' ? 'Offline · ' : 'Not connected · ') + st;
    $('status').innerHTML = state.error ? '<span class="offline">' + esc(st) + '</span>' : esc(st);
  }

  function tickCountdowns() {
    var els = document.querySelectorAll('[data-leave]');
    for (var i = 0; i < els.length; i++) els[i].innerHTML = countdown(Number(els[i].getAttribute('data-leave')));
  }

  $('banners').addEventListener('click', function (e) {
    var b = e.target.closest('[data-banner]');
    if (b && b.getAttribute('data-banner') === 'phone') openSettings('phone');
  });

  // Skip / Undo buttons on cards (options are plain links to directions)
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

  function renderCalendars(cals, selected) {
    $('calList').innerHTML = cals && cals.length ? cals.map(function (cal) {
      var on = selected.indexOf(cal.id) >= 0;
      return '<label class="check"><input type="checkbox" data-cal="' + esc(cal.id) + '"' + (on ? ' checked' : '') + '> ' +
        esc(cal.name) + (cal.primary ? ' <span class="hint">(main)</span>' : '') + '</label>';
    }).join('') : 'No calendars found.';
  }

  function fillSettings(view) {
    var s = view.settings;
    state.serverSettings = s;
    $('s_homeAddress').value = s.homeAddress || '';
    NUM_FIELDS.forEach(function (k) { $('s_' + k).value = s[k]; });
    BOOL_FIELDS.forEach(function (k) { $('s_' + k).checked = !!s[k]; });
    $('s_directionsApp').value = s.directionsApp === 'citymapper' ? 'citymapper' : 'google';
    renderCalendars(view.calendars || [], s.calendarIds || ['primary']);
    setTripFieldsEnabled(true);
  }

  function readSettings() {
    var s = { homeAddress: $('s_homeAddress').value.trim(), directionsApp: $('s_directionsApp').value };
    NUM_FIELDS.forEach(function (k) { s[k] = Number($('s_' + k).value); });
    BOOL_FIELDS.forEach(function (k) { s[k] = $('s_' + k).checked; });
    s.calendarIds = checkedCalendars();
    if (!s.calendarIds) delete s.calendarIds;
    return s;
  }

  function checkedCalendars() {
    var boxes = document.querySelectorAll('[data-cal]');
    if (!boxes.length) return null;
    var ids = Array.prototype.filter.call(boxes, function (b) { return b.checked; })
      .map(function (b) { return b.getAttribute('data-cal'); });
    return ids.length ? ids : ['primary'];
  }

  /** Full settings load: first run (nothing cached yet) or after connecting. */
  function loadServerSettings() {
    if (isDemo()) { fillSettings(demoSettings()); return; }
    var c = conn();
    if (!c.url || !c.key) { setTripFieldsEnabled(false); $('connection').open = true; return; }
    $('saveResult').textContent = 'Loading settings…';
    api('settings').then(function (v) {
      updateCache({ settings: v.settings, calendars: v.calendars, calendarsAt: Date.now() });
      state.pushPublicKey = v.pushPublicKey || state.pushPublicKey;
      fillSettings(v);
      $('saveResult').textContent = '';
    }).catch(function (e) {
      setTripFieldsEnabled(false);
      $('connection').open = true;
      $('saveResult').textContent = '❌ ' + e.message;
    });
  }

  /** Background refresh of the calendar list; keeps whatever boxes you've already ticked. */
  function refreshCalendars() {
    if (isDemo()) return;
    $('refreshCalsBtn').textContent = 'Refreshing…';
    api('settings').then(function (v) {
      updateCache({ calendars: v.calendars, calendarsAt: Date.now() });
      state.pushPublicKey = v.pushPublicKey || state.pushPublicKey;
      if (!state.serverSettings) { fillSettings(v); return; }
      renderCalendars(v.calendars, checkedCalendars() || state.serverSettings.calendarIds || ['primary']);
    }).catch(function () { /* keep the cached list */ }).then(function () {
      $('refreshCalsBtn').textContent = 'Refresh list';
    });
  }

  function openSettings(section) {
    var c = conn();
    $('apiUrl').value = c.url;
    $('apiKey').value = c.key;
    showUrlHint();
    $('testResult').textContent = '';
    $('saveResult').textContent = '';
    $('checkResult').hidden = true;
    if (!$('settings').open) { $('settings').showModal(); $('settings').scrollTop = 0; }
    var cache = readCache();
    if (isDemo()) {
      fillSettings(demoSettings());
    } else if (cache && cache.settings && c.url && c.key) {
      fillSettings(cache); // instant; fields stay editable
      if (!cache.calendarsAt || Date.now() - cache.calendarsAt > CALENDARS_MAX_AGE) refreshCalendars();
    } else {
      loadServerSettings();
    }
    updatePhoneSection();
    if (section === 'phone') $('phoneSettings').scrollIntoView({ block: 'start' });
  }

  function saveConnection() {
    LS.set('apiUrl', $('apiUrl').value.trim());
    LS.set('apiKey', $('apiKey').value.trim());
    syncConn();
  }

  function showUrlHint() {
    var t = urlProblem($('apiUrl').value.trim());
    $('urlHint').hidden = !t;
    $('urlHint').textContent = t;
  }

  $('settingsBtn').addEventListener('click', function () { openSettings(); });
  $('apiUrl').addEventListener('input', showUrlHint);
  $('refreshCalsBtn').addEventListener('click', refreshCalendars);
  $('connectBtn').addEventListener('click', function () {
    saveConnection();
    showUrlHint();
    state.data = null;
    state.serverSettings = null;
    loadServerSettings();
    load('plans');
  });

  $('settingsForm').addEventListener('submit', function (e) {
    if (e.submitter && e.submitter.value !== 'save') return; // Close button
    e.preventDefault();
    saveConnection();
    if (isDemo() || !state.serverSettings) { $('settings').close(); load('plans'); return; }
    var btn = $('saveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    $('saveResult').textContent = '';
    apiPost({ action: 'saveSettings', settings: readSettings() }).then(function (v) {
      updateCache({ settings: v.settings });
      state.serverSettings = v.settings;
      if (state.data) state.data.settings = v.settings;
      $('settings').close();
      render();
      load('update'); // re-plan in the background; only trips whose settings changed ask Google Maps again
    }).catch(function (err) {
      $('saveResult').textContent = '❌ ' + err.message;
    }).then(function () { btn.disabled = false; btn.textContent = 'Save'; });
  });

  // ── Check connection ──
  $('checkBtn').addEventListener('click', function () {
    saveConnection();
    showUrlHint();
    var out = $('checkResult');
    var show = function (lines) {
      out.hidden = false;
      out.innerHTML = lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('');
    };
    if (isDemo()) { show(['Demo mode — nothing to check.']); return; }
    show(['Checking…']);
    api('ping').then(function (r) {
      state.pushPublicKey = r.pushPublicKey || state.pushPublicKey;
      var match = r.version === EXPECTED_BACKEND_VERSION;
      show([
        '✓ Script reachable',
        '✓ Key accepted',
        (match ? '✓ Version ' + r.version + ' (matches the app)'
          : '✗ Version ' + (r.version || 'old') + ' — the app expects ' + EXPECTED_BACKEND_VERSION + '. Paste the latest Code.gs and deploy a new version.'),
        (r.hasTimer ? '✓ Background timer running' : '✗ Background timer not running — run setup in the script') +
          (r.lastRunAt ? ' · last check ' + fmt(r.lastRunAt) : ' · no check yet'),
        (r.pushDevices ? '✓ ' : '✗ ') + r.pushDevices + ' device' + (r.pushDevices === 1 ? '' : 's') + ' registered for notifications'
      ]);
    }).catch(function (e) {
      if (e.kind === 'key') show(['✓ Script reachable', '✗ Key not accepted — reopen the setup link from getAppLink']);
      else show(['✗ Script not reachable — ' + e.message, 'See "How to fix" on the main screen.']);
    });
  });

  // ── This phone: install ──
  var installEvt = null;
  var bootAt = Date.now();
  function isInstalled() {
    try { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch (e) { return false; }
  }
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); // we show our own Install button instead of Chrome's bar
    installEvt = e;
    updateInstallUI();
  });
  window.addEventListener('appinstalled', function () { installEvt = null; updateInstallUI(); });

  function updateInstallUI() {
    var inst = isInstalled();
    $('installStatus').textContent = inst ? 'Installed ✓' : 'Not installed';
    $('installBtn').hidden = inst || !installEvt;
    $('installChip').hidden = inst || !installEvt;
    var help = '';
    if (!inst && !installEvt) {
      if (!('onbeforeinstallprompt' in window)) help = 'Use your browser\'s menu → Add to Home screen.';
      else if (Date.now() - bootAt > 3000) help = CHROME_SAYS_INSTALLED; // Chrome never offered to install
      else setTimeout(updateInstallUI, 3100 - (Date.now() - bootAt));
    }
    $('installHelp').hidden = !help;
    $('installHelp').textContent = help;
  }
  function promptInstall() {
    if (!installEvt) return;
    installEvt.prompt();
    installEvt.userChoice.then(function () { installEvt = null; updateInstallUI(); });
  }
  $('installBtn').addEventListener('click', promptInstall);
  $('installChip').addEventListener('click', promptInstall);

  // ── This phone: notifications ──
  function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(function (resolve) { setTimeout(function () { resolve(null); }, ms); })]);
  }
  function currentSub() {
    return withTimeout(navigator.serviceWorker.ready.then(function (r) { return r.pushManager.getSubscription(); }), 3000)
      .catch(function () { return null; });
  }
  function keyBytes(b64) {
    var s = (b64 + '===='.slice(0, (4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(s);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function sameKey(buf, bytes) {
    if (!buf) return false;
    var a = new Uint8Array(buf);
    if (a.length !== bytes.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== bytes[i]) return false;
    return true;
  }
  function setNotifHelp(t) { $('notifHelp').hidden = !t; $('notifHelp').textContent = t || ''; }

  function updateNotifUI() {
    var btn = $('enableNotifBtn');
    if (!pushSupported()) {
      $('notifStatus').textContent = 'Not available in this browser';
      btn.hidden = true;
      return;
    }
    if (Notification.permission === 'denied') {
      $('notifStatus').textContent = 'Blocked';
      btn.hidden = true;
      setNotifHelp(BLOCKED_TEXT);
      return;
    }
    currentSub().then(function (sub) {
      var on = Notification.permission === 'granted' && !!sub;
      $('notifStatus').textContent = on ? 'On ✓' : 'Off';
      btn.hidden = on;
    });
  }

  function updatePhoneSection() {
    updateInstallUI();
    updateNotifUI();
  }

  /** Subscribe with the script's public key (replacing a subscription made with an older key). */
  function subscribeWithKey(reg, b64) {
    var appKey = keyBytes(b64);
    return reg.pushManager.getSubscription().then(function (old) {
      if (old && !sameKey(old.options && old.options.applicationServerKey, appKey)) return old.unsubscribe().then(function () { return null; });
      return old;
    }).then(function (old) {
      return old || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    });
  }

  $('enableNotifBtn').addEventListener('click', function () {
    if (isDemo()) { setNotifHelp('Demo mode — nothing to enable.'); return; }
    if (!isInstalled()) { setNotifHelp('Install the app first, then enable notifications here.'); return; }
    if (!pushSupported()) return;
    setNotifHelp('Turning on…');
    saveConnection();
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') throw new Error(perm === 'denied' ? BLOCKED_TEXT : 'Notifications weren\'t allowed.');
      return api('ping');
    }).then(function (r) {
      if (!r.pushPublicKey) throw new Error('Your Google script is out of date — paste the latest Code.gs first.');
      state.pushPublicKey = r.pushPublicKey;
      return navigator.serviceWorker.ready.then(function (reg) { return subscribeWithKey(reg, r.pushPublicKey); });
    }).then(function (sub) {
      if (KV) KV.set('pushPublicKey', state.pushPublicKey).catch(function () {});
      return apiPost({ action: 'subscribe', endpoint: sub.endpoint });
    }).then(function (r) {
      // Start the inbox from now, so old messages don't pop up.
      return (KV ? KV.set('lastInboxId', r.lastId || 0) : Promise.resolve()).catch(function () {});
    }).then(function () {
      setNotifHelp('✅ This phone will get notifications. Tap Send test notification to try it.');
      updateNotifUI();
      load('plans');
    }).catch(function (e) {
      setNotifHelp('❌ ' + e.message);
      updateNotifUI();
    });
  });

  $('testBtn').addEventListener('click', function () {
    if (isDemo()) { $('testResult').textContent = 'Demo mode — nothing sent.'; return; }
    saveConnection();
    $('testResult').textContent = 'Sending…';
    api('test').then(function (r) {
      $('testResult').textContent = r.devices === 0 ? 'No device registered — tap Enable notifications first.'
        : r.accepted > 0 ? 'Sent to ' + r.accepted + ' device' + (r.accepted === 1 ? '' : 's') + ' — it should pop up in a few seconds.'
        : 'Your phone didn\'t accept it (push service replied ' + r.statuses.join(', ') + '). Tap Enable notifications again.';
    }).catch(function (e) { $('testResult').textContent = '❌ ' + e.message; });
  });

  /** On every open: keep this phone on the script's device list (cheap, and keeps it fresh). */
  function refreshSubscription() {
    if (isDemo() || !pushSupported() || Notification.permission !== 'granted' || !conn().url || !conn().key) return;
    currentSub().then(function (sub) {
      if (sub) apiPost({ action: 'subscribe', endpoint: sub.endpoint }).catch(function () {});
    });
  }

  $('refreshBtn').addEventListener('click', function () { load('refresh'); });

  // ── Demo data (open the app with ?demo to preview) ──
  function demoSettings() {
    return {
      settings: { homeAddress: 'Canal St Station, New York, NY', walkToStationMin: 5, maxWalkMin: 20, minEarlyMin: 0, maxEarlyMin: 10,
        headsUpMin: 90, warningMin: 15, quietStartHour: 22, quietEndHour: 7, chainEvents: true, subwayOnly: true, checkAlerts: true, showEventDetails: true, includeMultiDay: false,
        directionsApp: 'google', calendarIds: ['primary'] },
      calendars: [{ id: 'primary', name: 'Me', primary: true }, { id: 'family', name: 'Family' }]
    };
  }
  function demoData() {
    var now = Date.now(), m = 60000;
    var start1 = Math.ceil((now + 95 * m) / (15 * m)) * 15 * m;
    var start2 = start1 + 150 * m;
    var tomorrow = Math.ceil((now + 24 * 60 * m) / (60 * m)) * 60 * m;
    var leg = function (line, dep, from, to, stops, vehicle) {
      return { line: line, vehicle: vehicle || 'SUBWAY', from: from, to: to, departAt: dep, stops: stops, headsign: '' };
    };
    var home = { address: 'Canal St Station, New York, NY', lat: 40.7191, lng: -74.0014, label: 'home' };
    var carbone = { address: '181 Thompson St, New York, NY 10012', lat: 40.7279, lng: -74.0003 };
    return {
      updatedAt: now, version: EXPECTED_BACKEND_VERSION, origin: home.address, settings: demoSettings().settings, pushDevices: 1,
      plans: [
        { key: 'a', title: 'Dinner w/ Sam', location: 'Carbone, 181 Thompson St, New York, NY', start: start1, status: 'ok', fromHome: true,
          alerts: [], origin: home, dest: carbone,
          options: [
            { type: 'transit', recommended: true, leaveAt: start1 - 33 * m, arriveAt: start1 - 6 * m, early: 6,
              legs: [leg('C', start1 - 28 * m, 'Canal St', 'Spring St', 3)] },
            { type: 'transit', leaveAt: start1 - 35 * m, arriveAt: start1 - 8 * m, early: 8, delayed: true,
              legs: [leg('A', start1 - 30 * m, 'Canal St', 'Spring St', 3)] },
            { type: 'walk', leaveAt: start1 - 26 * m, arriveAt: start1 - 5 * m, early: 5, walkMin: 21, legs: [] }
          ] },
        { key: 'b', title: 'Drinks in Astoria', location: 'Bohemian Hall, 29-19 24th Ave, Queens', start: start2, status: 'ok',
          fromHome: false, originLabel: 'Dinner w/ Sam', alerts: [{ routes: ['N'], text: 'Some northbound N trains are running with delays.' }],
          origin: { address: carbone.address, lat: carbone.lat, lng: carbone.lng, label: 'Dinner w/ Sam' },
          dest: { address: '29-19 24th Ave, Queens, NY 11105', lat: 40.7736, lng: -73.9168 },
          options: [{ type: 'transit', recommended: true, leaveAt: start2 - 55 * m, arriveAt: start2 - 4 * m, early: 4, delayBufferMin: 5, delayed: true,
            legs: [leg('R', start2 - 50 * m, 'Prince St', '57 St-7 Av', 8), leg('N', start2 - 28 * m, '57 St-7 Av', 'Astoria Blvd', 7)] }] },
        { key: 'c', title: 'Coffee w/ Priya', location: 'Black Fox Coffee, 70 Pine St', start: start2 + 30 * m, status: 'ok', skipped: true, options: [], alerts: [] },
        { key: 'd', title: 'Housewarming', location: 'Brooklyn', start: start2 + 60 * m, status: 'vague', options: [], alerts: [] },
        { key: 'e', title: 'Team offsite', location: 'Hoboken, NJ', start: tomorrow, status: 'not_nyc', options: [], alerts: [] }
      ]
    };
  }

  // ── Boot ──
  readHashSetup();
  syncConn();
  if (!isDemo()) { try { state.data = JSON.parse(LS.get('lastData') || 'null'); } catch (e) { /* ignore */ } }
  render();
  load('plans');
  refreshSubscription();
  updateInstallUI();
  setInterval(tickCountdowns, 30000);
  setInterval(function () { if (!document.hidden) load('plans'); }, 5 * 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load('plans'); });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
})();
