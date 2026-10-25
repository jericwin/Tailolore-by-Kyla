const db = require('../server/db');
const { createApp } = require('../server/app');

try {
  db.open();
  db.migrate({ log: () => {} });
} catch (err) {
  console.error('Database migration/init warning in serverless environment:', err);
}

const app = createApp();

module.exports = app;
