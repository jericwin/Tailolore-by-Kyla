const db = require('../server/db');
const auth = require('../server/lib/auth');
const { createApp } = require('../server/app');

try {
  db.open();
  db.migrate({ log: () => {} });

  // Ensure default accounts are present
  const admin = db.one("SELECT id FROM users WHERE email = 'admin@tailoredbykyla.com'");
  if (!admin) {
    auth.hashPassword('Password123!').then((hash) => {
      try {
        db.run(
          "INSERT INTO users (email, password_hash, role, full_name) VALUES (?, ?, 'admin', 'Kyla') ON CONFLICT(email) DO NOTHING",
          'admin@tailoredbykyla.com',
          hash
        );
      } catch (e) {
        console.error('Error seeding admin in serverless:', e);
      }
    }).catch(console.error);
  }

  const cust = db.one("SELECT id FROM users WHERE email = 'customer@example.com'");
  if (!cust) {
    auth.hashPassword('Password123!').then((hash) => {
      try {
        db.run(
          "INSERT INTO users (email, password_hash, role, full_name) VALUES (?, ?, 'customer', 'Sample Customer') ON CONFLICT(email) DO NOTHING",
          'customer@example.com',
          hash
        );
      } catch (e) {
        console.error('Error seeding customer in serverless:', e);
      }
    }).catch(console.error);
  }
} catch (err) {
  console.error('Database migration/init warning in serverless environment:', err);
}

const app = createApp();

module.exports = app;
