const config = require('../server/config');
const db = require('../server/db');

db.open();
console.log(`Database: ${config.databaseFile}`);
const n = db.migrate();
console.log(n ? `Done — ${n} migration(s) applied.` : 'Already up to date.');
db.close();
