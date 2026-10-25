// Rental calendar: choose the event date, then pickup and return around it.
// Unavailable days come from /api/gowns/:id/availability (dates only). The
// native date inputs remain the source of truth and the no-JS fallback; the
// server re-checks everything on submit.
(function () {
  'use strict';
  window.TBK = window.TBK || {};

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

  function iso(d) { return d.toISOString().slice(0, 10); }
  function parse(s) { return new Date(s + 'T00:00:00Z'); }
  function add(s, n) { var d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
  function span(a, b) { return Math.round((parse(b) - parse(a)) / 864e5) + 1; }
  function nice(s) { var d = parse(s); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()].slice(0, 3) + ' ' + d.getUTCFullYear(); }

  window.TBK.datepicker = function () {
    var root = document.querySelector('[data-datepicker]');
    if (!root) return;
    var form = root.closest('form');
    var inputs = {
      event: form.querySelector('[name="event_date"]'),
      pickup: form.querySelector('[name="pickup_date"]'),
      ret: form.querySelector('[name="return_date"]'),
    };
    var fallback = form.querySelector('[data-datepicker-fallback]');
    var grid = root.querySelector('[data-grid]');
    var monthLabel = root.querySelector('[data-month]');
    var stepLabel = root.querySelector('[data-step]');
    var prevBtn = root.querySelector('[data-prev]');
    var nextBtn = root.querySelector('[data-next]');
    var summary = root.querySelector('[data-summary]');
    var period = Number(root.getAttribute('data-period')) || 0;
    var min = root.getAttribute('data-min');
    var max = root.getAttribute('data-max');
    var blocked = new Set();
    var loadedTo = null;
    var state = { event: inputs.event.value || null, pickup: inputs.pickup.value || null, ret: inputs.ret.value || null };
    var view = parse(state.event || min);
    view.setUTCDate(1);
    var focusDate = state.event || min;

    root.hidden = false;
    if (fallback) fallback.hidden = true;

    function step() {
      if (!state.event) return 'event';
      if (!state.pickup) return 'pickup';
      if (!state.ret) return 'ret';
      return 'done';
    }

    function rangeHasBlocked(a, b) {
      for (var d = a; d <= b; d = add(d, 1)) if (blocked.has(d)) return true;
      return false;
    }

    function selectable(d) {
      if (d < min || d > max || blocked.has(d)) return false;
      var s = step();
      if (s === 'event' || s === 'done') return true;
      if (s === 'pickup') {
        if (d > state.event) return false;
        if (period && span(d, state.event) > period) return false;
        return !rangeHasBlocked(d, state.event);
      }
      if (s === 'ret') {
        if (d < state.event) return false;
        if (period && span(state.pickup, d) > period) return false;
        return !rangeHasBlocked(state.pickup, d);
      }
      return false;
    }

    function sync() {
      inputs.event.value = state.event || '';
      inputs.pickup.value = state.pickup || '';
      inputs.ret.value = state.ret || '';
      var s = step();
      stepLabel.innerHTML = {
        event: '<strong>1 · </strong>Choose your event date.',
        pickup: '<strong>2 · </strong>Choose the pickup date — on or before ' + nice(state.event) + '.',
        ret: '<strong>3 · </strong>Choose the return date' + (period ? ' (up to ' + period + ' days from pickup)' : '') + '.',
        done: 'Dates chosen. Kyla confirms availability when she reviews your request.',
      }[s];
      if (summary) {
        summary.querySelector('[data-sum-pickup]').textContent = state.pickup ? nice(state.pickup) : '—';
        summary.querySelector('[data-sum-event]').textContent = state.event ? nice(state.event) : '—';
        summary.querySelector('[data-sum-return]').textContent = state.ret ? nice(state.ret) : '—';
      }
    }

    function load(from) {
      var to = add(from, 120);
      if (loadedTo && to <= loadedTo) return Promise.resolve();
      return fetch('/api/gowns/' + root.getAttribute('data-gown') + '/availability?from=' + from + '&to=' + to, { headers: { accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data) return;
          data.unavailable.forEach(function (d) { blocked.add(d); });
          if (!loadedTo || data.to > loadedTo) loadedTo = data.to;
        }).catch(function () { /* the server still validates */ });
    }

    function render(keepFocus) {
      var y = view.getUTCFullYear();
      var m = view.getUTCMonth();
      monthLabel.textContent = MONTHS[m] + ' ' + y;
      var first = iso(view);
      prevBtn.disabled = first <= min.slice(0, 8) + '01';
      nextBtn.disabled = first >= max.slice(0, 8) + '01';
      grid.textContent = '';
      DOW.forEach(function (d) {
        var h = document.createElement('span');
        h.className = 'datepick__dow'; h.textContent = d; h.setAttribute('aria-hidden', 'true');
        grid.appendChild(h);
      });
      var offset = (view.getUTCDay() + 6) % 7;
      for (var i = 0; i < offset; i++) grid.appendChild(document.createElement('span'));
      var days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      var today = min;
      if (focusDate.slice(0, 7) !== first.slice(0, 7)) focusDate = first < min ? min : first;
      for (var day = 1; day <= days; day++) {
        var d = iso(new Date(Date.UTC(y, m, day)));
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'datepick__day';
        b.textContent = String(day);
        b.setAttribute('data-date', d);
        var label = nice(d);
        if (blocked.has(d)) { b.classList.add('is-booked'); label += ', unavailable'; }
        if (d === today) b.classList.add('is-today');
        if (state.pickup && state.ret && d > state.pickup && d < state.ret) b.classList.add('is-range');
        if (state.pickup && !state.ret && state.event && d > state.pickup && d < state.event) b.classList.add('is-range');
        if (d === state.pickup) { b.classList.add('is-pickup'); label += ', pickup'; }
        if (d === state.ret) { b.classList.add('is-return'); label += ', return'; }
        if (d === state.event) { b.classList.add('is-event'); label += ', event'; }
        b.setAttribute('aria-label', label);
        b.disabled = !selectable(d) && !(d === state.event || d === state.pickup || d === state.ret);
        b.tabIndex = d === focusDate ? 0 : -1;
        grid.appendChild(b);
      }
      if (!grid.querySelector('[tabindex="0"]:not([disabled])')) {
        var firstEnabled = grid.querySelector('.datepick__day:not([disabled])');
        if (firstEnabled) firstEnabled.tabIndex = 0;
      }
      if (keepFocus) {
        var f = grid.querySelector('[data-date="' + focusDate + '"]');
        if (f && !f.disabled) f.focus();
      }
      sync();
    }

    function choose(d) {
      var s = step();
      if (s === 'done' || s === 'event') { state = { event: d, pickup: null, ret: null }; }
      else if (s === 'pickup') state.pickup = d;
      else if (s === 'ret') state.ret = d;
      // Same-day pickup and return around the event are common; offer the event day as the default boundary.
      focusDate = d;
      render(true);
    }

    grid.addEventListener('click', function (e) {
      var b = e.target.closest('.datepick__day');
      if (!b || b.disabled) return;
      var d = b.getAttribute('data-date');
      if (selectable(d)) choose(d);
    });
    grid.addEventListener('keydown', function (e) {
      var deltas = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      if (!(e.key in deltas)) return;
      e.preventDefault();
      var next = add(focusDate, deltas[e.key]);
      if (next < min || next > max) return;
      focusDate = next;
      var n = parse(next);
      if (n.getUTCMonth() !== view.getUTCMonth()) { view = parse(next.slice(0, 8) + '01'); load(next).then(function () { render(true); }); }
      else render(true);
    });
    prevBtn.addEventListener('click', function () { view.setUTCMonth(view.getUTCMonth() - 1); render(); });
    nextBtn.addEventListener('click', function () {
      view.setUTCMonth(view.getUTCMonth() + 1);
      load(iso(view)).then(function () { render(); });
    });
    var reset = root.querySelector('[data-reset]');
    if (reset) reset.addEventListener('click', function () { state = { event: null, pickup: null, ret: null }; render(); });

    form.addEventListener('submit', function (e) {
      if (step() !== 'done') {
        e.preventDefault();
        stepLabel.classList.add('error');
        stepLabel.focus && stepLabel.setAttribute('tabindex', '-1');
        stepLabel.focus();
      }
    });

    render();
    load(min).then(function () { render(); });
  };
})();
