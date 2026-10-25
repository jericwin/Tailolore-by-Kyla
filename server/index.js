const config = require('./config');
const db = require('./db');
const auth = require('./lib/auth');
const notify = require('./lib/notify');
const { createApp } = require('./app');

db.open();
const applied = db.migrate({ log: () => {} });
if (applied) console.log(`Applied ${applied} database migration(s).`);

const admins = db.one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").n;
if (!admins) {
  console.warn('No studio administrator exists yet. Create one with:  npm run create-admin');
}

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`Tailored by Kyla running at ${config.baseUrl} (${config.env})`);
});

// Housekeeping: reminders for pickups/returns and expired sessions.
function housekeeping() {
  try {
    notify.sendDateReminders();
    auth.purgeExpiredSessions();
  } catch (err) {
    console.error('Housekeeping failed', err);
  }
}
housekeeping();
const timer = setInterval(housekeeping, 60 * 60 * 1000);

function shutdown() {
  clearInterval(timer);
  server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
