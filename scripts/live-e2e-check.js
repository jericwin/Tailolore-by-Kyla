const BASE = 'https://tailored-by-kyla.vercel.app';

async function runTests() {
  console.log('=== STARTING LIVE VERCEL VERIFICATION ===\n');
  let failures = 0;

  function assert(condition, name) {
    if (condition) {
      console.log(`[PASS] ${name}`);
    } else {
      console.error(`[FAIL] ${name}`);
      failures++;
    }
  }

  // 1. Static Assets
  console.log('--- 1. Testing Frontend Static Assets ---');
  const cssRes = await fetch(`${BASE}/static/css/app.css`);
  assert(cssRes.status === 200, 'GET /static/css/app.css returns 200');

  const baseCssRes = await fetch(`${BASE}/static/css/base.css`);
  assert(baseCssRes.status === 200, 'GET /static/css/base.css returns 200');

  const jsRes = await fetch(`${BASE}/static/js/site.js`);
  assert(jsRes.status === 200, 'GET /static/js/site.js returns 200');

  // 2. Public Pages
  console.log('\n--- 2. Testing Frontend Public Pages ---');
  const homeRes = await fetch(`${BASE}/`);
  assert(homeRes.status === 200, 'GET / (Home) returns 200');
  const homeText = await homeRes.text();
  assert(homeText.includes('Tailored by Kyla'), 'Home HTML contains brand title');

  const collectionRes = await fetch(`${BASE}/collection`);
  assert(collectionRes.status === 200, 'GET /collection returns 200');
  const colText = await collectionRes.text();
  assert(colText.includes('lookbook__grid') || colText.includes('lookbook'), 'Collection contains gowns grid');

  const atelierRes = await fetch(`${BASE}/atelier`);
  assert(atelierRes.status === 200, 'GET /atelier returns 200');

  const galleryRes = await fetch(`${BASE}/gallery`);
  assert(galleryRes.status === 200, 'GET /gallery returns 200');

  // 3. Media Serving
  console.log('\n--- 3. Testing Media Serving ---');
  const imgMatch = colText.match(/\/media\/g\/[a-zA-Z0-9_\-\.]+\.webp/);
  if (imgMatch) {
    const imgUrl = `${BASE}${imgMatch[0]}`;
    const imgRes = await fetch(imgUrl);
    assert(imgRes.status === 200 && imgRes.headers.get('content-type')?.includes('image/webp'), `Image ${imgMatch[0]} serves 200 WebP`);
  } else {
    console.warn('[WARN] No gown image found in collection HTML to test');
  }

  // 4. Backend Authentication: Admin Login
  console.log('\n--- 4. Testing Backend Admin Auth ---');
  const loginGet = await fetch(`${BASE}/login`);
  assert(loginGet.status === 200, 'GET /login returns 200');
  const loginHtml = await loginGet.text();
  const cookies = loginGet.headers.getSetCookie();
  const csrfMatch = loginHtml.match(/name="_csrf" value="([^"]+)"/);
  const csrf = csrfMatch ? csrfMatch[1] : '';
  assert(csrf.length > 0, 'CSRF token parsed from login page');

  const cookieHeader = cookies.map(c => c.split(';')[0]).join('; ');

  const adminLoginRes = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieHeader,
      'Referer': `${BASE}/login`
    },
    body: new URLSearchParams({
      _csrf: csrf,
      email: 'admin@tailoredbykyla.com',
      password: 'Password123!',
      next: ''
    }).toString(),
    redirect: 'manual'
  });

  assert(adminLoginRes.status === 302, `Admin login returns 302 redirect (got ${adminLoginRes.status})`);
  const adminRedirect = adminLoginRes.headers.get('location');
  assert(adminRedirect?.includes('/studio'), `Admin redirects to /studio (got ${adminRedirect})`);

  // Verify access to /studio with session
  const adminCookies = adminLoginRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const studioRes = await fetch(`${BASE}/studio`, {
    headers: { 'Cookie': `${cookieHeader}; ${adminCookies}` }
  });
  assert(studioRes.status === 200, `Authenticated GET /studio returns 200 (got ${studioRes.status})`);

  // 5. Backend Authentication: Customer Login
  console.log('\n--- 5. Testing Backend Customer Auth ---');
  const custLoginRes = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieHeader,
      'Referer': `${BASE}/login`
    },
    body: new URLSearchParams({
      _csrf: csrf,
      email: 'customer@example.com',
      password: 'Password123!',
      next: ''
    }).toString(),
    redirect: 'manual'
  });

  assert(custLoginRes.status === 302, `Customer login returns 302 redirect (got ${custLoginRes.status})`);
  const custRedirect = custLoginRes.headers.get('location');
  assert(custRedirect?.includes('/account'), `Customer redirects to /account (got ${custRedirect})`);

  // Verify access to /account with session
  const custCookies = custLoginRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const accountRes = await fetch(`${BASE}/account`, {
    headers: { 'Cookie': `${cookieHeader}; ${custCookies}` }
  });
  assert(accountRes.status === 200, `Authenticated GET /account returns 200 (got ${accountRes.status})`);

  // 6. Backend Customer Registration Flow
  console.log('\n--- 6. Testing Backend Customer Registration ---');
  const regGet = await fetch(`${BASE}/register`);
  assert(regGet.status === 200, 'GET /register returns 200');
  const regHtml = await regGet.text();
  const regCsrfMatch = regHtml.match(/name="_csrf" value="([^"]+)"/);
  const regCsrf = regCsrfMatch ? regCsrfMatch[1] : '';
  const regCookies = regGet.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

  const testEmail = `testuser_${Date.now()}@example.com`;
  const regPostRes = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': regCookies,
      'Referer': `${BASE}/register`
    },
    body: new URLSearchParams({
      _csrf: regCsrf,
      full_name: 'Live Test Customer',
      email: testEmail,
      phone: '0917 555 1234',
      password: 'Password123!',
      password_confirm: 'Password123!'
    }).toString(),
    redirect: 'manual'
  });

  assert(regPostRes.status === 302, `New user registration returns 302 redirect (got ${regPostRes.status})`);
  const regRedirect = regPostRes.headers.get('location');
  assert(regRedirect?.includes('/account'), `New user redirects to /account (got ${regRedirect})`);

  console.log(`\n=== VERIFICATION COMPLETE: ${failures} FAILURES ===`);
  if (failures > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
