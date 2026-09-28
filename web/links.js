// Leave By — directions links for Google Maps and Citymapper. Used by app.js and the tests.
(function (root) {
  'use strict';

  function enc(v) { return encodeURIComponent(String(v)); }
  function hasCoords(pt) { return !!pt && typeof pt.lat === 'number' && typeof pt.lng === 'number'; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /** A time as ISO 8601 with New York's offset, e.g. 2026-09-28T18:53:00-04:00. */
  function nyIso(ms) {
    var parts = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(ms)).forEach(function (p) { parts[p.type] = p.value; });
    var h = Number(parts.hour) % 24;
    var wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), h, Number(parts.minute), Number(parts.second));
    var off = Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
    var sign = off < 0 ? '-' : '+';
    off = Math.abs(off);
    return parts.year + '-' + parts.month + '-' + parts.day + 'T' + pad(h) + ':' + parts.minute + ':' + parts.second +
      sign + pad(Math.floor(off / 60)) + ':' + pad(off % 60);
  }

  /** Google Maps directions. Maps links can't carry a time, so Maps shows trips leaving now. */
  function googleMapsUrl(origin, dest, mode) {
    if (!dest || !dest.address) return null;
    return 'https://www.google.com/maps/dir/?api=1' +
      (origin && origin.address ? '&origin=' + enc(origin.address) : '') +
      '&destination=' + enc(dest.address) +
      '&travelmode=' + (mode === 'walking' ? 'walking' : 'transit');
  }

  /** Citymapper directions arriving by a time. Needs the destination's coordinates. */
  function citymapperUrl(origin, dest, title, arriveAt) {
    if (!hasCoords(dest)) return null;
    var q = [];
    if (hasCoords(origin)) {
      q.push('startcoord=' + enc(origin.lat + ',' + origin.lng));
      if (origin.label) q.push('startname=' + enc(origin.label));
      if (origin.address) q.push('startaddress=' + enc(origin.address));
    }
    q.push('endcoord=' + enc(dest.lat + ',' + dest.lng));
    if (title) q.push('endname=' + enc(title));
    if (dest.address) q.push('endaddress=' + enc(dest.address));
    if (arriveAt) q.push('arrival_time=' + enc(nyIso(arriveAt)));
    return 'https://citymapper.com/directions?' + q.join('&');
  }

  /** The link for one option of a plan, in the chosen app ('google' or 'citymapper'). */
  function directionsUrl(app, plan, option) {
    var dest = plan.dest || (plan.address ? { address: plan.address } : null);
    if (app === 'citymapper') {
      var cm = citymapperUrl(plan.origin, dest, plan.title, option && option.arriveAt);
      if (cm) return cm;
    }
    return googleMapsUrl(plan.origin, dest, option && option.type === 'walk' ? 'walking' : 'transit');
  }

  var api = { googleMapsUrl: googleMapsUrl, citymapperUrl: citymapperUrl, directionsUrl: directionsUrl, nyIso: nyIso };
  root.LeaveByLinks = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
