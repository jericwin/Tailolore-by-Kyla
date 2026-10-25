// Full-screen viewer for gown photographs.
// Markup: buttons with data-lightbox="group" data-src data-srcset data-caption data-href.
(function () {
  'use strict';
  window.TBK = window.TBK || {};

  window.TBK.lightbox = function () {
    var triggers = Array.prototype.slice.call(document.querySelectorAll('[data-lightbox]'));
    if (!triggers.length) return;
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var box = document.createElement('div');
    box.className = 'lightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Photograph viewer');
    box.innerHTML =
      '<div class="lightbox__bar"><span class="note" data-count></span><button type="button" data-close>Close ×</button></div>' +
      '<div class="lightbox__stage" data-stage><img alt="" data-img></div>' +
      '<div class="lightbox__foot"><span class="lightbox__caption" data-caption></span>' +
      '<span class="lightbox__nav"><button type="button" data-prev>← Prev</button><button type="button" data-next>Next →</button></span></div>';
    document.body.appendChild(box);

    var img = box.querySelector('[data-img]');
    var caption = box.querySelector('[data-caption]');
    var count = box.querySelector('[data-count]');
    var list = [];
    var index = 0;
    var opener = null;

    function pad(n) { return n < 10 ? '0' + n : String(n); }

    function show(i, instant) {
      index = (i + list.length) % list.length;
      var t = list[index];
      function swap() {
        img.src = t.getAttribute('data-src');
        if (t.getAttribute('data-srcset')) img.srcset = t.getAttribute('data-srcset'); else img.removeAttribute('srcset');
        img.sizes = '100vw';
        img.alt = t.getAttribute('data-alt') || '';
        var href = t.getAttribute('data-href');
        caption.textContent = '';
        var text = t.getAttribute('data-caption') || '';
        if (href) {
          var a = document.createElement('a');
          a.href = href; a.textContent = text;
          caption.appendChild(a);
        } else caption.textContent = text;
        count.textContent = pad(index + 1) + ' / ' + pad(list.length);
        img.classList.remove('is-leaving');
      }
      if (instant || reduce) swap();
      else { img.classList.add('is-leaving'); setTimeout(swap, 220); }
      var multi = list.length > 1;
      box.querySelector('[data-prev]').hidden = !multi;
      box.querySelector('[data-next]').hidden = !multi;
    }

    function open(trigger) {
      var group = trigger.getAttribute('data-lightbox');
      list = triggers.filter(function (t) { return t.getAttribute('data-lightbox') === group && t.offsetParent !== null; });
      if (!list.length) list = [trigger];
      opener = trigger;
      show(list.indexOf(trigger) < 0 ? 0 : list.indexOf(trigger), true);
      box.classList.add('is-open');
      document.body.classList.add('lightbox-open');
      box.querySelector('[data-close]').focus();
    }

    function close() {
      box.classList.remove('is-open');
      document.body.classList.remove('lightbox-open');
      if (opener) opener.focus();
    }

    triggers.forEach(function (t) {
      t.addEventListener('click', function (e) { e.preventDefault(); open(t); });
    });
    box.querySelector('[data-close]').addEventListener('click', close);
    box.querySelector('[data-prev]').addEventListener('click', function () { show(index - 1); });
    box.querySelector('[data-next]').addEventListener('click', function () { show(index + 1); });
    box.querySelector('[data-stage]').addEventListener('click', function (e) { if (e.target === e.currentTarget) close(); });

    document.addEventListener('keydown', function (e) {
      if (!box.classList.contains('is-open')) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') show(index + 1);
      else if (e.key === 'ArrowLeft') show(index - 1);
      else if (e.key === 'Tab') {
        // Keep focus inside the dialog.
        var focusables = Array.prototype.slice.call(box.querySelectorAll('button:not([hidden]), a[href]'));
        var first = focusables[0];
        var last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    // Swipe between photographs on touch screens.
    var startX = null;
    var stage = box.querySelector('[data-stage]');
    stage.addEventListener('touchstart', function (e) { startX = e.touches[0].clientX; }, { passive: true });
    stage.addEventListener('touchend', function (e) {
      if (startX === null) return;
      var dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) > 50) show(index + (dx < 0 ? 1 : -1));
      startX = null;
    });
  };
})();
