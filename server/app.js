const path = require('node:path');
const express = require('express');
const nunjucks = require('nunjucks');
const config = require('./config');
const auth = require('./lib/auth');
const settings = require('./lib/settings');
const status = require('./lib/status');
const images = require('./lib/images');
const notify = require('./lib/notify');
const { money, moneyInput } = require('./lib/util');
const { formatDate, formatStamp, today } = require('./lib/dates');
const { HttpError, ValidationError } = require('./lib/errors');

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ }
  }
  return out;
}

function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'", // inline style attributes carry per-image aspect ratios
      "script-src 'self'",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (config.isProd) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

/** One-shot messages carried across a redirect in a short-lived cookie. */
function flash(req, res, next) {
  const raw = req.cookies.tbk_flash;
  res.locals.flash = null;
  if (raw) {
    try { res.locals.flash = JSON.parse(raw); } catch { /* ignore */ }
    res.clearCookie('tbk_flash', { path: '/' });
  }
  req.flash = (type, message) => {
    res.cookie('tbk_flash', JSON.stringify({ type, message: String(message).slice(0, 400) }),
      { httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/', maxAge: 60_000 });
  };
  next();
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy === 'true' ? true : Number(config.trustProxy) || config.trustProxy);

  const env = nunjucks.configure(path.join(config.root, 'views'), {
    autoescape: true,
    express: app,
    noCache: !config.isProd,
    throwOnUndefined: false,
  });
  app.set('view engine', 'njk');
  env.addFilter('money', money);
  env.addFilter('moneyInput', moneyInput);
  env.addFilter('date', (s, style) => formatDate(s, style));
  env.addFilter('stamp', formatStamp);
  env.addFilter('pad', (n, len = 2) => String(n).padStart(len, '0'));
  env.addFilter('nl2p', (s) => {
    const escape = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    return new nunjucks.runtime.SafeString(
      String(s || '').split(/\n{2,}/).map((p) => `<p>${escape(p).replace(/\n/g, '<br>')}</p>`).join(''));
  });
  // href('/collection', currentFilters, { service: 'rent' }) → '/collection?service=rent&…', dropping empty values.
  env.addGlobal('href', (base, current = {}, changes = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...current, ...changes })) if (v) params.set(k, v);
    const q = params.toString();
    return q ? `${base}?${q}` : base;
  });
  env.addGlobal('status', status);
  env.addGlobal('srcset', images.srcset);
  env.addGlobal('imgSrc', images.src);
  env.addGlobal('today', today);
  env.addGlobal('isProd', config.isProd);
  env.addGlobal('assetVersion', Date.now().toString(36));

  app.use(securityHeaders);
  app.use('/static', express.static(path.join(config.root, 'public'), {
    maxAge: config.isProd ? '7d' : 0,
    fallthrough: true,
  }));
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/static/img/brand/favicon-64.png'));

  app.use((req, res, next) => { req.cookies = parseCookies(req.headers.cookie); next(); });
  app.use(express.urlencoded({ extended: false, limit: '200kb', parameterLimit: 200 }));
  app.use(express.json({ limit: '100kb' }));
  app.use(flash);
  app.use(auth.loadUser);
  app.use(auth.csrf);
  app.use((req, res, next) => {
    res.locals.site = settings.all();
    res.locals.path = req.path;
    res.locals.query = req.query;
    res.locals.unread = req.user ? notify.unreadCount(req.user.id) : 0;
    next();
  });

  app.use(require('./routes/media'));
  app.use(require('./routes/public'));
  app.use(require('./routes/auth'));
  app.use('/account', require('./routes/account'));
  app.use(require('./routes/requests'));
  app.use('/studio', auth.requireAdmin, require('./routes/studio'));

  app.use((req, res, next) => next(new HttpError(404, 'We couldn’t find that page.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const statusCode = err instanceof HttpError ? err.status : 500;
    if (statusCode >= 500) console.error(err);
    const message = statusCode >= 500 ? 'Something went wrong on our side. Please try again in a moment.' : err.message;
    if (req.accepts(['html', 'json']) === 'json' || req.xhr || req.get('x-requested-with') === 'fetch') {
      return res.status(statusCode).json({ error: message, errors: err instanceof ValidationError ? err.errors : undefined });
    }
    // A rejected form post goes back to the page it came from with the reason shown there.
    if (req.method === 'POST' && [409, 422].includes(statusCode) && req.get('referer')) {
      try {
        const ref = new URL(req.get('referer'));
        if (ref.host === req.get('host')) {
          const detail = err instanceof ValidationError ? Object.values(err.errors)[0] : null;
          req.flash('error', detail && message.startsWith('Please check') ? detail : message);
          return res.redirect(ref.pathname + ref.search + ref.hash);
        }
      } catch { /* fall through to the error page */ }
    }
    res.status(statusCode).render('error.njk', { statusCode, message, area: req.path.startsWith('/studio') ? 'studio' : 'site' });
  });

  return app;
}

module.exports = { createApp };
