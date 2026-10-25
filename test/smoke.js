// Quick route check: boots the app on a spare port and requests key pages.
// Usage: node test/smoke.js
const db = require('../server/db');
const { createApp } = require('../server/app');

db.open();
db.migrate({ log: () => {} });
const app = createApp();
const port = 3999;
const paths = process.argv.slice(2).length ? process.argv.slice(2) : [
  '/', '/collection', '/collection?service=rent', '/gallery', '/atelier', '/commission', '/login', '/register',
  '/does-not-exist', '/studio', '/account', '/api/gowns/1/availability',
];

const server = app.listen(port, async () => {
  let failed = 0;
  for (const p of paths) {
    const r = await fetch(`http://localhost:${port}${p}`, { redirect: 'manual' });
    const t = await r.text();
    if (r.status >= 500) failed++;
    console.log(r.status, p, r.headers.get('location') || '', r.status >= 500 ? t.slice(0, 400) : '');
  }
  server.close();
  db.close();
  process.exit(failed ? 1 : 0);
});
