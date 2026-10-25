// End-to-end checks of the customer and studio workflows over real HTTP,
// against a throwaway database. Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tbk-test-'));
process.env.DATABASE_FILE = path.join(tmp, 'test.db');
process.env.STORAGE_DIR = path.join(tmp, 'storage');
process.env.NODE_ENV = 'test';

const sharp = require('sharp');
const db = require('../server/db');
const auth = require('../server/lib/auth');
const { createApp } = require('../server/app');
const { today, addDays } = require('../server/lib/dates');

let server;
let base;

/** Minimal browser: keeps cookies and knows the CSRF token. */
function client() {
  const jar = new Map();
  const c = {
    get csrf() { return jar.get('tbk_csrf'); },
    async req(method, url, { form, body, headers = {}, multipart } = {}) {
      const h = { ...headers, cookie: [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '), referer: base + '/' };
      let payload;
      if (form) {
        h['content-type'] = 'application/x-www-form-urlencoded';
        payload = new URLSearchParams({ _csrf: c.csrf || '', ...form }).toString();
      } else if (multipart) {
        multipart.set('_csrf', c.csrf || '');
        payload = multipart;
      } else payload = body;
      const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
      for (const sc of res.headers.getSetCookie()) {
        const [pair] = sc.split(';');
        const i = pair.indexOf('=');
        const k = pair.slice(0, i);
        const v = decodeURIComponent(pair.slice(i + 1));
        if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(sc) || v === '') jar.delete(k); else jar.set(k, v);
      }
      res.text_ = await res.text();
      return res;
    },
    get(url, opts) { return c.req('GET', url, opts); },
    post(url, form, opts = {}) { return c.req('POST', url, { form, ...opts }); },
  };
  return c;
}

async function signUp(name, email) {
  const c = client();
  await c.get('/register');
  const r = await c.post('/register', { full_name: name, email, phone: '0917 123 4567', password: 'correct horse battery', password_confirm: 'correct horse battery' });
  assert.equal(r.status, 302, r.text_.slice(0, 300));
  return c;
}

async function signIn(email, password) {
  const c = client();
  await c.get('/login');
  const r = await c.post('/login', { email, password });
  assert.equal(r.status, 302, `login failed for ${email}`);
  return c;
}

let kyla; let ana; let ben; let gownId; let gownSlug;

before(async () => {
  db.open();
  db.migrate({ log: () => {} });
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  db.run("INSERT INTO users (email, password_hash, role, full_name) VALUES (?, ?, 'admin', 'Kyla')",
    'kyla@test.local', await auth.hashPassword('studio password 1'));
  kyla = await signIn('kyla@test.local', 'studio password 1');
  ana = await signUp('Ana Cruz', 'ana@test.local');
  ben = await signUp('Ben Reyes', 'ben@test.local');
});

after(() => {
  server.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('registration always creates a customer, even if a role is submitted', async () => {
  const c = client();
  await c.get('/register');
  await c.post('/register', { full_name: 'Sneaky', email: 'sneaky@test.local', password: 'another password', password_confirm: 'another password', role: 'admin' });
  assert.equal(db.one('SELECT role FROM users WHERE email = ?', 'sneaky@test.local').role, 'customer');
  const r = await c.get('/studio');
  assert.equal(r.status, 404, 'customers must not reach the studio');
});

test('studio is closed to visitors and customers', async () => {
  assert.equal((await client().get('/studio')).status, 302);
  assert.equal((await ana.get('/studio/gowns')).status, 404);
  const r = await ana.post('/studio/gowns/new', { name: 'Hack', offer_rental: '1', rental_price: '1' });
  assert.equal(r.status, 404);
  assert.equal(db.one("SELECT COUNT(*) AS n FROM gowns WHERE name = 'Hack'").n, 0);
});

test('forms without the CSRF token are refused', async () => {
  const r = await ana.req('POST', '/account/messages', { body: 'body=hello', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 403);
});

test('login is rate limited after repeated failures', async () => {
  const c = client();
  await c.get('/login');
  let last;
  for (let i = 0; i < 9; i++) last = await c.post('/login', { email: 'ben@test.local', password: 'wrong password' });
  assert.equal(last.status, 429);
  db.run('DELETE FROM login_attempts');
});

test('Kyla creates, photographs and publishes a gown', async () => {
  let r = await kyla.post('/studio/gowns/new', {
    name: 'Ivory Column', description: 'Test gown', offer_rental: '1', rental_price: '8,500', rental_period_days: '3',
    security_deposit: '2000', offer_purchase: '1', purchase_price: '45000', offer_custom: '1', sizes: 'S, M', units: '1',
  });
  assert.equal(r.status, 302);
  const g = db.one("SELECT * FROM gowns WHERE name = 'Ivory Column'");
  gownId = g.id; gownSlug = g.slug;
  assert.equal(g.rental_price, 850000);
  assert.equal(g.listing_status, 'draft');

  // Not visible before publishing.
  assert.equal((await client().get(`/gowns/${gownSlug}`)).status, 404);
  // Publishing without photos is refused.
  await kyla.post(`/studio/gowns/${gownId}/listing`, { listing_status: 'published' });
  assert.equal(db.one('SELECT listing_status FROM gowns WHERE id = ?', gownId).listing_status, 'draft');

  // A non-image is rejected; a real image is accepted and re-encoded.
  const bad = new FormData();
  bad.append('photos', new Blob(['not an image'], { type: 'image/jpeg' }), 'x.jpg');
  r = await kyla.req('POST', `/studio/gowns/${gownId}/photos`, { multipart: bad });
  assert.equal(db.one('SELECT COUNT(*) AS n FROM gown_images WHERE gown_id = ?', gownId).n, 0);

  const png = await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#d6c3ad' } }).jpeg().toBuffer();
  const fd = new FormData();
  fd.append('photos', new Blob([png], { type: 'image/jpeg' }), 'gown.jpg');
  r = await kyla.req('POST', `/studio/gowns/${gownId}/photos`, { multipart: fd });
  assert.equal(r.status, 302, r.text_.slice(0, 200));
  const img = db.one('SELECT * FROM gown_images WHERE gown_id = ?', gownId);
  assert.ok(img && img.is_main === 1);

  // Draft images are private.
  assert.equal((await client().get(`/media/g/${img.file_key}-960.webp`)).status, 404);
  assert.equal((await kyla.get(`/media/g/${img.file_key}-960.webp`)).status, 200);

  await kyla.post(`/studio/gowns/${gownId}/listing`, { listing_status: 'published' });
  assert.equal(db.one('SELECT listing_status FROM gowns WHERE id = ?', gownId).listing_status, 'published');
  const page = await client().get(`/gowns/${gownSlug}`);
  assert.equal(page.status, 200);
  assert.match(page.text_, /₱8,500/);
  assert.equal((await client().get(`/media/g/${img.file_key}-960.webp`)).status, 200);
});

test('rental request → approval blocks the dates → no double booking', async () => {
  const event = addDays(today(), 30);
  const window = { event_date: event, pickup_date: addDays(event, -1), return_date: addDays(event, 1), size_note: 'S' };

  // Over-long window is refused (period is 3 days).
  let r = await ana.post(`/gowns/${gownSlug}/rent`, { ...window, return_date: addDays(event, 3) });
  assert.equal(r.status, 422);

  r = await ana.post(`/gowns/${gownSlug}/rent`, window);
  assert.equal(r.status, 302, r.text_.slice(0, 300));
  const anaRental = db.one('SELECT * FROM rentals WHERE customer_id = (SELECT id FROM users WHERE email = ?)', 'ana@test.local');
  assert.equal(anaRental.status, 'requested');
  assert.equal(anaRental.quoted_price, 850000);

  // A pending request does not block anyone: Ben can request overlapping dates.
  r = await ben.post(`/gowns/${gownSlug}/rent`, window);
  assert.equal(r.status, 302);
  const benRental = db.one('SELECT * FROM rentals WHERE customer_id = (SELECT id FROM users WHERE email = ?)', 'ben@test.local');

  // Customers cannot see each other's rentals.
  assert.equal((await ben.get(`/account/rentals/${anaRental.id}`)).status, 404);
  assert.equal((await ben.post(`/account/rentals/${anaRental.id}/cancel`, {})).status, 404);

  // Customers cannot approve their own request.
  r = await ana.post(`/studio/rentals/${anaRental.id}/status`, { to: 'confirmed' });
  assert.equal(r.status, 404);

  // Confirming directly is refused while a deposit is outstanding.
  await kyla.post(`/studio/rentals/${anaRental.id}/status`, { to: 'confirmed' });
  assert.equal(db.one('SELECT status FROM rentals WHERE id = ?', anaRental.id).status, 'requested');

  r = await kyla.post(`/studio/rentals/${anaRental.id}/status`, { to: 'awaiting_deposit' });
  assert.equal(r.status, 302);
  let row = db.one('SELECT * FROM rentals WHERE id = ?', anaRental.id);
  assert.equal(row.status, 'awaiting_deposit');
  assert.ok(row.unit_id);

  // The single piece is now held: approving Ben's overlapping request fails.
  await kyla.post(`/studio/rentals/${benRental.id}/status`, { to: 'awaiting_deposit' });
  assert.equal(db.one('SELECT status FROM rentals WHERE id = ?', benRental.id).status, 'requested');

  // And the dates show as unavailable publicly, without customer details.
  const avail = await client().get(`/api/gowns/${gownId}/availability?from=${today()}`);
  const json = JSON.parse(avail.text_);
  assert.ok(json.unavailable.includes(event));
  assert.ok(!avail.text_.includes('Ana'));

  // New requests for those dates are refused at submission.
  const carl = await signUp('Carl', 'carl@test.local');
  r = await carl.post(`/gowns/${gownSlug}/rent`, window);
  assert.equal(r.status, 422);

  // Recording the deposit confirms the booking and notifies Ana.
  await kyla.post(`/studio/rentals/${anaRental.id}/deposit`, { deposit_status: 'received' });
  row = db.one('SELECT * FROM rentals WHERE id = ?', anaRental.id);
  assert.equal(row.status, 'confirmed');
  const notes = db.all('SELECT kind FROM notifications WHERE user_id = ?', row.customer_id).map((n) => n.kind);
  assert.ok(notes.includes('rental_confirmed'));

  // Pickup → return with damage note → complete.
  await kyla.post(`/studio/rentals/${anaRental.id}/status`, { to: 'picked_up' });
  assert.equal(db.one('SELECT availability_status FROM gowns WHERE id = ?', gownId).availability_status, 'rented');
  await kyla.post(`/studio/rentals/${anaRental.id}/return`, { return_condition: 'damaged', damage_notes: 'Small tear at hem' });
  row = db.one('SELECT * FROM rentals WHERE id = ?', anaRental.id);
  assert.equal(row.status, 'returned');
  assert.equal(row.damage_notes, 'Small tear at hem');
  assert.equal(db.one('SELECT availability_status FROM gowns WHERE id = ?', gownId).availability_status, 'available');

  // Once the dates are free again, Ben's request can be approved.
  await kyla.post(`/studio/rentals/${anaRental.id}/status`, { to: 'completed' });
  await kyla.post(`/studio/rentals/${benRental.id}/status`, { to: 'rejected' }); // note is required
  assert.equal(db.one('SELECT status FROM rentals WHERE id = ?', benRental.id).status, 'requested');
  await kyla.post(`/studio/rentals/${benRental.id}/status`, { to: 'rejected', note: 'Those dates went to another client.' });
  assert.equal(db.one('SELECT status FROM rentals WHERE id = ?', benRental.id).status, 'rejected');
});

test('concurrent approvals of overlapping requests cannot both succeed', async () => {
  const event = addDays(today(), 60);
  const window = { event_date: event, pickup_date: event, return_date: addDays(event, 1) };
  const dana = await signUp('Dana', 'dana@test.local');
  const eli = await signUp('Eli', 'eli@test.local');
  await dana.post(`/gowns/${gownSlug}/rent`, window);
  await eli.post(`/gowns/${gownSlug}/rent`, window);
  const ids = db.all("SELECT id FROM rentals WHERE status = 'requested' AND event_date = ?", event).map((r) => r.id);
  assert.equal(ids.length, 2);
  db.run("UPDATE rentals SET quoted_deposit = NULL WHERE id IN (?, ?)", ids[0], ids[1]);
  await Promise.all(ids.map((id) => kyla.post(`/studio/rentals/${id}/status`, { to: 'confirmed' })));
  const confirmed = db.one("SELECT COUNT(*) AS n FROM rentals WHERE event_date = ? AND status = 'confirmed'", event).n;
  assert.equal(confirmed, 1);
});

test('purchase inquiry → confirm reserves the piece → payment → complete', async () => {
  // Make the only piece free of future rentals so it can be sold.
  db.run("UPDATE rentals SET status = 'cancelled' WHERE gown_id = ? AND status IN ('confirmed','awaiting_deposit','requested')", gownId);
  let r = await ben.post(`/gowns/${gownSlug}/order`, { fulfillment: 'delivery', delivery_address: '' });
  assert.equal(r.status, 422, 'delivery needs an address');
  r = await ben.post(`/gowns/${gownSlug}/order`, { fulfillment: 'pickup', size_note: 'M' });
  assert.equal(r.status, 302);
  const order = db.one('SELECT * FROM orders WHERE gown_id = ?', gownId);
  assert.equal(order.status, 'pending');
  assert.equal(order.payment_status, 'unpaid');
  assert.equal((await ana.get(`/account/orders/${order.id}`)).status, 404);

  await kyla.post(`/studio/orders/${order.id}/status`, { to: 'confirmed' });
  assert.equal(db.one('SELECT status FROM gown_units WHERE gown_id = ?', gownId).status, 'reserved_sale');
  assert.equal(db.one('SELECT availability_status FROM gowns WHERE id = ?', gownId).availability_status, 'reserved');

  // Completing before payment is verified is refused.
  await kyla.post(`/studio/orders/${order.id}/status`, { to: 'processing' });
  await kyla.post(`/studio/orders/${order.id}/status`, { to: 'ready' });
  await kyla.post(`/studio/orders/${order.id}/status`, { to: 'completed' });
  assert.equal(db.one('SELECT status FROM orders WHERE id = ?', order.id).status, 'ready');

  await kyla.post(`/studio/orders/${order.id}/payment`, { payment_status: 'verified', payment_note: 'GCash ref 123' });
  await kyla.post(`/studio/orders/${order.id}/status`, { to: 'completed' });
  assert.equal(db.one('SELECT status FROM orders WHERE id = ?', order.id).status, 'completed');
  assert.equal(db.one('SELECT availability_status FROM gowns WHERE id = ?', gownId).availability_status, 'sold');

  // A sold gown can no longer be rented: the form is refused and nothing is recorded.
  const before = db.one('SELECT COUNT(*) AS n FROM rentals').n;
  r = await ana.post(`/gowns/${gownSlug}/rent`, { event_date: addDays(today(), 90), pickup_date: addDays(today(), 90), return_date: addDays(today(), 90) });
  assert.ok([302, 409].includes(r.status));
  assert.equal(db.one('SELECT COUNT(*) AS n FROM rentals').n, before);
});

test('custom request with private inspiration → quotation → accept → approve', async () => {
  const fd = new FormData();
  fd.set('event_type', 'Debut');
  fd.set('event_date', addDays(today(), 120));
  fd.set('contact_name', 'Ana Cruz');
  fd.set('contact_email', 'ana@test.local');
  fd.set('m_bust', '34 in');
  fd.set('budget_min', '20000');
  fd.set('budget_max', '35000');
  const jpg = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#e6d2c9' } }).jpeg().toBuffer();
  fd.append('inspiration', new Blob([jpg], { type: 'image/jpeg' }), 'idea.jpg');
  let r = await ana.req('POST', '/commission', { multipart: fd });
  assert.equal(r.status, 302, r.text_.slice(0, 300));
  const req = db.one("SELECT * FROM custom_requests WHERE event_type = 'Debut'");
  assert.equal(req.status, 'pending_review');
  assert.equal(JSON.parse(req.measurements).bust, '34 in');
  const imgId = db.one('SELECT id FROM custom_request_images WHERE request_id = ?', req.id).id;

  // Inspiration images and measurements are private to Ana and the studio.
  assert.equal((await ana.get(`/media/p/${imgId}/thumb`)).status, 200);
  assert.equal((await kyla.get(`/media/p/${imgId}/full`)).status, 200);
  assert.equal((await ben.get(`/media/p/${imgId}/thumb`)).status, 404);
  assert.equal((await client().get(`/media/p/${imgId}/thumb`)).status, 404);
  assert.equal((await ben.get(`/account/custom/${req.id}`)).status, 404);

  // Approving before a quotation is accepted is impossible.
  await kyla.post(`/studio/custom/${req.id}/status`, { to: 'approved' });
  assert.equal(db.one('SELECT status FROM custom_requests WHERE id = ?', req.id).status, 'pending_review');

  await kyla.post(`/studio/custom/${req.id}/quotations`, { amount: '32000', downpayment: '10000', details: 'Two fittings included.' });
  assert.equal(db.one('SELECT status FROM custom_requests WHERE id = ?', req.id).status, 'quotation_sent');
  const q = db.one('SELECT * FROM quotations WHERE request_id = ?', req.id);
  assert.equal(q.amount, 3200000);

  // Ben cannot accept Ana's quotation.
  assert.equal((await ben.post(`/account/custom/${req.id}/quotations/${q.id}/accept`, {})).status, 404);

  await ana.post(`/account/custom/${req.id}/quotations/${q.id}/accept`, { response: 'Yes please' });
  assert.equal(db.one('SELECT status FROM custom_requests WHERE id = ?', req.id).status, 'awaiting_approval');
  await kyla.post(`/studio/custom/${req.id}/status`, { to: 'approved', note: 'Downpayment received' });
  assert.equal(db.one('SELECT status FROM custom_requests WHERE id = ?', req.id).status, 'approved');
  await kyla.post(`/studio/custom/${req.id}/brief`, { agreed_measurements: 'Bust 34', fitting_date: addDays(today(), 60), deadline: addDays(today(), 110) });
  await kyla.post(`/studio/custom/${req.id}/status`, { to: 'in_progress' });
  assert.equal(db.one('SELECT status FROM custom_requests WHERE id = ?', req.id).status, 'in_progress');

  const page = await ana.get(`/account/custom/${req.id}`);
  assert.match(page.text_, /In progress/);
  assert.ok(!page.text_.includes('Bust 34'), 'agreed studio notes stay private');
});

test('messages stay between the customer and the studio', async () => {
  await ana.post(`/gowns/${gownSlug}/ask`, { body: 'Is this available in blush?' });
  const thread = db.one("SELECT * FROM threads WHERE subject_type = 'gown' AND subject_id = ?", gownId);
  assert.ok(thread);
  assert.equal((await ben.get(`/account/messages/${thread.id}`)).status, 404);
  assert.equal((await ben.post(`/account/messages/${thread.id}`, { body: 'hi' })).status, 404);
  await kyla.post(`/studio/messages/${thread.id}`, { body: 'Let me check for you.' });
  const page = await ana.get(`/account/messages/${thread.id}`);
  assert.match(page.text_, /Let me check for you/);
});

test('wishlist toggles and is per customer', async () => {
  await ana.post(`/wishlist/${gownId}`, {});
  assert.equal(db.one('SELECT COUNT(*) AS n FROM wishlist').n, 1);
  const r = await ana.req('POST', `/wishlist/${gownId}`, { form: {}, headers: { 'x-requested-with': 'fetch', accept: 'application/json' } });
  assert.deepEqual(JSON.parse(r.text_), { saved: false });
});

test('a gown with order history cannot be deleted', async () => {
  await kyla.post(`/studio/gowns/${gownId}/delete`, { confirm_name: 'Ivory Column' });
  assert.ok(db.one('SELECT 1 FROM gowns WHERE id = ?', gownId));
});

test('escaping: user text is never rendered as HTML', async () => {
  await ana.post('/account/settings', { full_name: '<script>alert(1)</script>', email: 'ana@test.local' });
  const page = await kyla.get('/studio/customers');
  assert.ok(!page.text_.includes('<script>alert(1)</script>'));
  assert.ok(page.text_.includes('&lt;script&gt;'));
});

test('photo library → new listing → sections → homepage showcase', async () => {
  const photo = (bg) => sharp({ create: { width: 800, height: 1000, channels: 3, background: bg } }).jpeg().toBuffer();
  const upload = async (bufs) => {
    const fd = new FormData();
    bufs.forEach((b, i) => fd.append('photos', new Blob([b], { type: 'image/jpeg' }), `crimson-set-${i}.jpg`));
    fd.append('category', 'menswear/pageant-formalwear');
    fd.append('kind', 'look');
    return kyla.req('POST', '/studio/library/upload', { multipart: fd });
  };
  const a = await photo('#7a1f1f'); const b = await photo('#1f3a7a');
  const before = db.one('SELECT COUNT(*) AS n FROM library_images').n;
  let r = await upload([a, b]);
  assert.equal(r.status, 302, r.text_.slice(0, 200));
  assert.equal(db.one('SELECT COUNT(*) AS n FROM library_images').n, before + 2);
  // The same file is only stored once.
  await upload([a]);
  assert.equal(db.one('SELECT COUNT(*) AS n FROM library_images').n, before + 2);

  const libs = db.all("SELECT * FROM library_images WHERE category = 'menswear/pageant-formalwear' ORDER BY id");
  // Library photographs not used by a published listing stay private.
  assert.equal((await client().get(`/media/g/${libs[0].file_key}-960.webp`)).status, 404);
  assert.equal((await kyla.get(`/media/g/${libs[0].file_key}-960.webp`)).status, 200);
  assert.equal((await kyla.get('/studio/library')).status, 200);

  // A new draft listing from the ticked photographs, in a category of the menswear section.
  r = await kyla.req('POST', '/studio/library/use', { body: new URLSearchParams([['_csrf', kyla.csrf], ['action', 'new'], ['ids', libs[0].id], ['ids', libs[1].id]]).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 302);
  const g = db.one('SELECT g.*, c.section FROM gowns g JOIN categories c ON c.id = g.category_id WHERE g.id = ?', Number(r.headers.get('location').split('/').pop()));
  assert.equal(g.listing_status, 'draft');
  assert.equal(g.section, 'menswear');
  assert.equal(g.rental_price, null); // nothing invented
  assert.equal(db.one('SELECT COUNT(*) AS n FROM gown_images WHERE gown_id = ?', g.id).n, 2);

  await kyla.post(`/studio/gowns/${g.id}/listing`, { listing_status: 'published' });
  assert.equal(db.one('SELECT listing_status FROM gowns WHERE id = ?', g.id).listing_status, 'published');
  assert.match((await client().get('/collection?section=menswear')).text_, new RegExp(g.name));
  assert.doesNotMatch((await client().get('/collection?section=gowns')).text_, new RegExp(g.name));

  // Homepage showcase: the masterpiece opens the site; signature pieces follow and can be reordered.
  await kyla.post(`/studio/gowns/${g.id}/showcase`, { role: 'masterpiece' });
  await kyla.post(`/studio/gowns/${gownId}/showcase`, { role: 'signature' });
  let home = (await client().get('/')).text_;
  assert.ok(home.indexOf('class="masterpiece"') > 0 && home.indexOf(g.name, home.indexOf('class="masterpiece"')) > 0);
  assert.match(home, /class="sig sig--p0 sig--gown/);
  await kyla.post(`/studio/showcase/${g.id}`, { action: 'signature' });
  assert.equal(db.one('SELECT COUNT(*) AS n FROM showcase WHERE role = ?', 'masterpiece').n, 0);
  await kyla.post(`/studio/showcase/${g.id}`, { action: 'up' });
  assert.deepEqual(db.all("SELECT gown_id FROM showcase WHERE role = 'signature' ORDER BY position").map((x) => x.gown_id), [g.id, gownId]);
  await kyla.post(`/studio/showcase/${gownId}`, { action: 'remove' });
  assert.equal(db.one('SELECT 1 AS x FROM showcase WHERE gown_id = ?', gownId), undefined);
  assert.equal((await kyla.get('/studio/showcase')).status, 200);
  // Unpublished gowns never reach the homepage.
  await kyla.post(`/studio/gowns/${g.id}/listing`, { listing_status: 'unpublished' });
  home = (await client().get('/')).text_;
  assert.doesNotMatch(home, new RegExp(g.name));
  await kyla.post(`/studio/gowns/${g.id}/listing`, { listing_status: 'published' });

  // Removing a photograph from a listing keeps it, and its files, in the library.
  const gi = db.one('SELECT * FROM gown_images WHERE gown_id = ? AND file_key = ?', g.id, libs[1].file_key);
  await kyla.post(`/studio/gowns/${g.id}/photos/${gi.id}/delete`, {});
  assert.equal(db.one('SELECT COUNT(*) AS n FROM gown_images WHERE id = ?', gi.id).n, 0);
  assert.ok(fs.existsSync(path.join(process.env.STORAGE_DIR, 'gowns', `${libs[1].file_key}-960.webp`)));
  // A library photograph in use can't be removed; an unused one can, with its files.
  await kyla.post(`/studio/library/${libs[0].id}/delete`, {});
  assert.ok(db.one('SELECT 1 AS x FROM library_images WHERE id = ?', libs[0].id));
  await kyla.post(`/studio/library/${libs[1].id}/delete`, {});
  assert.equal(db.one('SELECT 1 AS x FROM library_images WHERE id = ?', libs[1].id), undefined);
  assert.ok(!fs.existsSync(path.join(process.env.STORAGE_DIR, 'gowns', `${libs[1].file_key}-960.webp`)));
});

test('one sign-in page: each role lands in its own area, whatever the link asked for', async () => {
  const { landingFor } = require('../server/routes/auth');
  const admin = { role: 'admin' }; const customer = { role: 'customer' };
  assert.equal(landingFor(admin, ''), '/studio');
  assert.equal(landingFor(customer, ''), '/account');
  assert.equal(landingFor(customer, '/studio/gowns'), '/account');
  assert.equal(landingFor(admin, '/account/rentals'), '/studio');
  assert.equal(landingFor(customer, '/gowns/ivory-column?service=rent'), '/gowns/ivory-column?service=rent');
  assert.equal(landingFor(admin, '/studio/library'), '/studio/library');

  // Over HTTP: a customer following a studio link lands in their account; the studio lands in the studio.
  const c = client();
  await c.get('/login');
  let r = await c.post('/login', { email: 'ana@test.local', password: 'correct horse battery', next: '/studio/gowns' });
  assert.equal(r.headers.get('location'), '/account');
  const k = client();
  await k.get('/login');
  r = await k.post('/login', { email: 'kyla@test.local', password: 'studio password 1', next: '/account/messages' });
  assert.equal(r.headers.get('location'), '/studio');
  assert.equal((await k.get('/login')).headers.get('location'), '/studio');
});

test('help signing in: request → studio sets a temporary password → customer must choose a new one', async () => {
  // The reply is the same whether or not the account exists.
  const visitor = client();
  await visitor.get('/forgot-password');
  const known = await visitor.post('/forgot-password', { email: 'ben@test.local', contact: '0917 555 0101' });
  const unknown = await visitor.post('/forgot-password', { email: 'nobody@test.local', contact: '' });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  const strip = (h) => h.replace(/name="_csrf" value="[^"]*"|data-csrf="[^"]*"/g, '');
  assert.equal(strip(known.text_), strip(unknown.text_));

  const benRow = db.one("SELECT * FROM users WHERE email = 'ben@test.local'");
  assert.ok(benRow.password_help_at);
  assert.ok(db.one("SELECT 1 AS x FROM notifications WHERE kind = 'password_help' AND link = ?", `/studio/customers/${benRow.id}`));
  assert.match((await kyla.get(`/studio/customers/${benRow.id}`)).text_, /Asked for help signing in[\s\S]*0917 555 0101/);
  // Studio accounts are never reset this way.
  await visitor.post('/forgot-password', { email: 'kyla@test.local' });
  assert.equal(db.one("SELECT password_help_at FROM users WHERE email = 'kyla@test.local'").password_help_at, null);

  // Kyla issues a temporary password; Ben's old sessions end.
  const r = await kyla.post(`/studio/customers/${benRow.id}/reset-password`, {});
  const temp = r.text_.match(/user-select: all">([^<]+)</)[1];
  assert.equal(db.one('SELECT must_change_password FROM users WHERE id = ?', benRow.id).must_change_password, 1);
  assert.equal(db.one('SELECT password_help_at FROM users WHERE id = ?', benRow.id).password_help_at, null);
  assert.equal((await ben.get('/account')).status, 302);

  // Signing in with it leads straight to choosing a new password; the rest of the account waits.
  ben = await signIn('ben@test.local', temp);
  let page = await ben.get('/account/rentals');
  assert.equal(page.headers.get('location'), '/account/settings#password');
  await ben.post('/account/settings/password', { current_password: temp, new_password: 'a brand new password', new_password_confirm: 'a brand new password' });
  assert.equal(db.one('SELECT must_change_password FROM users WHERE id = ?', benRow.id).must_change_password, 0);
  page = await ben.get('/account/rentals');
  assert.equal(page.status, 200);
});

test('replying to a conversation marks it read for the sender', async () => {
  await ana.post('/account/messages', { body: 'One more question about sizes.' });
  const t = db.one('SELECT * FROM threads WHERE customer_id = (SELECT id FROM users WHERE email = ?) ORDER BY last_message_at DESC LIMIT 1', 'ana@test.local');
  assert.ok(db.one('SELECT studio_unread FROM threads WHERE id = ?', t.id).studio_unread > 0);
  await kyla.post(`/studio/messages/${t.id}`, { body: 'Of course — what size do you need?' });
  const after = db.one('SELECT studio_unread, customer_unread FROM threads WHERE id = ?', t.id);
  assert.equal(after.studio_unread, 0);
  assert.ok(after.customer_unread > 0);
});
