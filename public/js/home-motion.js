// Motion for the homepage, built on the language of the atelier: a measuring tape
// unrolls, the name is set letter by letter, a thread is sewn across the cover,
// and the plates drift at different depths as the page scrolls.
// It decorates a page that is already complete without it, and does nothing
// when the visitor has asked for reduced motion.
(function () {
  'use strict';

  if (!window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var doc = document.documentElement;
  doc.classList.add('motion');

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    splitLetters();
    wordReveals();
    depth();
  });

  // "Tailored" rises letter by letter. Screen readers still hear one word.
  function splitLetters() {
    document.querySelectorAll('[data-split]').forEach(function (el) {
      var text = el.textContent.trim();
      el.textContent = '';
      var spoken = document.createElement('span');
      spoken.className = 'visually-hidden';
      spoken.textContent = text;
      var shown = document.createElement('span');
      shown.className = 'split';
      shown.setAttribute('aria-hidden', 'true');
      text.split('').forEach(function (ch, i) {
        var s = document.createElement('span');
        s.className = 'split__ch';
        s.style.setProperty('--i', i);
        s.textContent = ch;
        shown.appendChild(s);
      });
      el.appendChild(spoken);
      el.appendChild(shown);
    });
  }

  function wordReveals() {
    var items = document.querySelectorAll('.reveal-words');
    if (!('IntersectionObserver' in window)) {
      items.forEach(function (el) { el.classList.add('is-in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.3 });
    items.forEach(function (el) { io.observe(el); });
  }

  // Scroll-linked depth. Each layer is measured on a box that never moves and the
  // offset is applied to its child, so the movement never feeds back into itself.
  // Only on wide screens: on phones the page simply scrolls.
  function depth() {
    var wide = window.matchMedia('(min-width: 900px)');
    var cover = document.querySelector('.cover');
    var layers = [];
    function layer(selector, speed) {
      document.querySelectorAll(selector).forEach(function (box) { layers.push({ box: box, speed: speed }); });
    }
    layer('.masterpiece__plate', -0.06);
    layer('.masterpiece__detail', 0.14);
    // Signature plates alternate between nearer and further.
    document.querySelectorAll('.sig').forEach(function (box, i) {
      var speeds = [-0.05, 0.08, 0.16, -0.03, 0.11, -0.07, 0.18, 0.06, -0.04, 0.1];
      layers.push({ box: box, speed: speeds[i % speeds.length] });
    });

    var queued = false;
    function frame() {
      queued = false;
      var vh = window.innerHeight;
      if (cover) {
        var r = cover.getBoundingClientRect();
        var p = Math.min(1, Math.max(0, -r.top / r.height));
        cover.style.setProperty('--p', p.toFixed(4));
      }
      if (!wide.matches) return;
      for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        var b = l.box.getBoundingClientRect();
        if (b.bottom < -vh * 0.5 || b.top > vh * 1.5) continue;
        // -1 when the box's centre is a screen above the middle, +1 a screen below.
        var c = (b.top + b.height / 2 - vh / 2) / vh;
        l.box.style.setProperty('--py', (c * l.speed * vh).toFixed(1) + 'px');
      }
    }
    function queue() {
      if (!queued) { queued = true; window.requestAnimationFrame(frame); }
    }
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
    wide.addEventListener('change', function () {
      if (!wide.matches) layers.forEach(function (l) { l.box.style.removeProperty('--py'); });
      queue();
    });
    frame();
  }
})();
