// Creates (or promotes) a studio administrator. This is the only way to get
// admin access — the website itself can never grant it.
//
//   npm run create-admin
//   npm run create-admin -- --email kyla@example.com --name "Kyla"
//
// The password is asked for interactively (input hidden). For unattended
// deployments it can be passed once through the ADMIN_PASSWORD environment variable.
const readline = require('node:readline');
const db = require('../server/db');
const auth = require('../server/lib/auth');
const { EMAIL_RE } = require('../server/lib/validate');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
        else rl.output.write(s.replace(/[^\r\n]/g, '•'));
      };
    }
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); });
  });
}

async function main() {
  db.open();
  db.migrate({ log: () => {} });

  const email = (arg('email') || process.env.ADMIN_EMAIL || await ask('Studio email: ')).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error('That is not a valid email address.');

  const existing = db.one('SELECT id, role FROM users WHERE email = ?', email);
  if (existing?.role === 'admin') {
    console.log('That account is already a studio administrator. To reset its password, run with --reset-password.');
    if (!process.argv.includes('--reset-password')) return;
  }

  let name = existing ? null : (arg('name') || process.env.ADMIN_NAME || await ask('Name shown on messages (e.g. Kyla): '));
  if (!existing && !name) name = 'Kyla';

  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = await ask('Password (min. 10 characters): ', { hidden: true });
    const again = await ask('Repeat password: ', { hidden: true });
    if (password !== again) throw new Error('The passwords don’t match.');
  }
  const problem = auth.passwordProblem(password);
  if (problem) throw new Error(problem);
  const hash = await auth.hashPassword(password);

  if (existing) {
    if (existing.role !== 'admin') {
      const ok = await ask(`${email} is a customer account. Promote it to studio administrator? (yes/no) `);
      if (ok.toLowerCase() !== 'yes') { console.log('Nothing changed.'); return; }
    }
    db.run("UPDATE users SET role = 'admin', password_hash = ?, disabled = 0, updated_at = ? WHERE id = ?", hash, new Date().toISOString(), existing.id);
    db.run('DELETE FROM sessions WHERE user_id = ?', existing.id);
    console.log(`Updated ${email}: studio administrator, new password set.`);
  } else {
    db.run("INSERT INTO users (email, password_hash, role, full_name) VALUES (?, ?, 'admin', ?)", email, hash, name);
    console.log(`Created studio administrator ${email}. Sign in at /login — you’ll be taken to /studio.`);
  }
}

main().then(() => db.close()).catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
