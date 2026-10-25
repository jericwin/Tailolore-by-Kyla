// Progressive enhancement for the public site and customer area.
// Every feature here has a no-JS fallback: links, plain forms and native date inputs.
(function () {
  'use strict';

  var doc = document.documentElement;
  doc.classList.add('js');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var csrf = document.body ? document.body.getAttribute('data-csrf') : '';

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    csrf = document.body.getAttribute('data-csrf');
    requestAnimationFrame(function () { requestAnimationFrame(function () { doc.classList.add('is-ready'); }); });
    menu();
    reveals();
    flash();
    wishlist();
    tabs();
    confirms();
    toggles();
    filePreviews();
    passwordToggles();
    accountNav();
    if (window.TBK && window.TBK.lightbox) window.TBK.lightbox();
    if (window.TBK && window.TBK.datepicker) window.TBK.datepicker();
  });

  function menu() {
    var toggle = document.querySelector('[data-menu-toggle]');
    var panel = document.querySelector('[data-menu]');
    if (!toggle || !panel) return;
    function set(open) {
      toggle.setAttribute('aria-expanded', String(open));
      panel.classList.toggle('is-open', open);
      document.body.classList.toggle('menu-open', open);
      toggle.querySelector('.menu-toggle__label').textContent = open ? 'Close' : 'Menu';
      if (open) { var first = panel.querySelector('a'); if (first) first.focus(); }
    }
    toggle.addEventListener('click', function () { set(toggle.getAttribute('aria-expanded') !== 'true'); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { set(false); toggle.focus(); }
    });
    window.matchMedia('(min-width: 861px)').addEventListener('change', function (mq) { if (mq.matches) set(false); });
  }

  function reveals() {
    var items = document.querySelectorAll('.reveal');
    if (!items.length) return;
    if (reduceMotion || !('IntersectionObserver' in window)) {
      items.forEach(function (el) { el.classList.add('is-in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add('is-in'); io.unobserve(entry.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach(function (el) { io.observe(el); });
  }

  function flash() {
    document.querySelectorAll('[data-flash] [data-dismiss]').forEach(function (btn) {
      btn.addEventListener('click', function () { btn.closest('[data-flash]').remove(); });
    });
  }

  // Wishlist: the button is a real form; JS turns it into an in-place toggle.
  function wishlist() {
    document.querySelectorAll('form[data-wish]').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var btn = form.querySelector('button');
        btn.disabled = true;
        fetch(form.action, {
          method: 'POST',
          headers: { 'x-requested-with': 'fetch', 'x-csrf-token': csrf, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams(new FormData(form)),
          credentials: 'same-origin',
        }).then(function (r) {
          if (r.status === 401) { window.location = '/login?next=' + encodeURIComponent(location.pathname); return null; }
          return r.json();
        }).then(function (data) {
          if (!data) return;
          btn.setAttribute('aria-pressed', String(data.saved));
          var label = btn.querySelector('[data-wish-label]');
          if (label) label.textContent = data.saved ? 'Saved' : 'Save';
        }).catch(function () { form.submit(); })
          .finally(function () { btn.disabled = false; });
      });
    });
  }

  // Rent / Buy / Commission tabs on the gown page (ARIA tabs pattern).
  function tabs() {
    document.querySelectorAll('[data-tabs]').forEach(function (root) {
      var buttons = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));
      function select(btn, focus) {
        buttons.forEach(function (b) {
          var on = b === btn;
          b.setAttribute('aria-selected', String(on));
          b.tabIndex = on ? 0 : -1;
          document.getElementById(b.getAttribute('aria-controls')).hidden = !on;
        });
        if (focus) btn.focus();
        var url = new URL(location.href);
        url.searchParams.set('service', btn.getAttribute('data-service'));
        history.replaceState(null, '', url);
      }
      buttons.forEach(function (b, i) {
        b.addEventListener('click', function () { select(b); });
        b.addEventListener('keydown', function (e) {
          var next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
          if (next === null) return;
          e.preventDefault();
          select(buttons[(next + buttons.length) % buttons.length], true);
        });
      });
    });
  }

  // Forms that need a second thought: <form data-confirm="Are you sure…">
  function confirms() {
    document.querySelectorAll('form[data-confirm]').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
      });
    });
    // Slow server work (uploads, background removal): show progress and prevent double submits.
    document.querySelectorAll('form[data-busy]').forEach(function (form) {
      form.addEventListener('submit', function () { form.classList.add('is-busy'); });
    });
  }

  // Show a block only when a control has a value: data-show-when="name=value"
  function toggles() {
    document.querySelectorAll('[data-show-when]').forEach(function (block) {
      var parts = block.getAttribute('data-show-when').split('=');
      var form = block.closest('form') || document;
      var inputs = form.querySelectorAll('[name="' + parts[0] + '"]');
      function update() {
        var on = false;
        inputs.forEach(function (i) {
          if ((i.type === 'radio' || i.type === 'checkbox') ? (i.checked && i.value === parts[1]) : i.value === parts[1]) on = true;
        });
        block.hidden = !on;
      }
      inputs.forEach(function (i) { i.addEventListener('change', update); });
      update();
    });
  }

  // A Show / Hide control on password fields, so a password can be checked before submitting.
  function passwordToggles() {
    document.querySelectorAll('input[type="password"]').forEach(function (input) {
      var wrap = document.createElement('span');
      wrap.className = 'pw';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pw__toggle';
      btn.textContent = 'Show';
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-label', 'Show password');
      btn.addEventListener('click', function () {
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.textContent = show ? 'Hide' : 'Show';
        btn.setAttribute('aria-pressed', String(show));
        btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        input.focus();
      });
      wrap.appendChild(btn);
    });
  }

  // On narrow screens the account menu scrolls sideways: keep the current page's
  // link in view and show which edges have more links.
  function accountNav() {
    var nav = document.querySelector('[data-acct-nav]');
    if (!nav) return;
    var current = nav.querySelector('[aria-current]');
    if (current && nav.scrollWidth > nav.clientWidth) {
      nav.scrollLeft = Math.max(0, current.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2);
    }
    function edges() {
      nav.classList.toggle('has-more-left', nav.scrollLeft > 4);
      nav.classList.toggle('has-more-right', nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 4);
    }
    nav.addEventListener('scroll', edges, { passive: true });
    window.addEventListener('resize', edges);
    edges();
  }

  function filePreviews() {
    document.querySelectorAll('input[type="file"][data-preview]').forEach(function (input) {
      var out = document.getElementById(input.getAttribute('data-preview'));
      if (!out) return;
      input.addEventListener('change', function () {
        out.textContent = '';
        Array.prototype.slice.call(input.files || [], 0, 12).forEach(function (f) {
          if (!/^image\//.test(f.type)) return;
          var img = document.createElement('img');
          img.alt = f.name;
          img.src = URL.createObjectURL(f);
          img.onload = function () { URL.revokeObjectURL(img.src); };
          out.appendChild(img);
        });
      });
    });
  }
})();
