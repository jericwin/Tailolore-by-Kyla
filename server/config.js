// Runtime configuration. Everything secret or environment-specific comes from
// environment variables (see .env.example); a local .env file is loaded if present.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

const envFile = path.join(root, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';
const isVercel = Boolean(process.env.VERCEL);

function resolveDir(value, fallback) {
  const dir = value ? path.resolve(root, value) : path.join(root, fallback);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Read-only filesystem on Vercel
  }
  return dir;
}

const storageDir = isVercel
  ? path.join('/tmp', 'storage')
  : resolveDir(process.env.STORAGE_DIR, 'storage');

if (isVercel) {
  try {
    fs.mkdirSync(path.join(storageDir, 'gowns'), { recursive: true });
    fs.mkdirSync(path.join(storageDir, 'private'), { recursive: true });
  } catch {}
}

const config = {
  root,
  env,
  isProd,
  isVercel,
  port: Number(process.env.PORT) || 3000,
  baseUrl: (process.env.BASE_URL || `http://localhost:${Number(process.env.PORT) || 3000}`).replace(/\/$/, ''),
  databaseFile: process.env.DATABASE_FILE
    ? path.resolve(root, process.env.DATABASE_FILE)
    : isVercel
      ? path.join('/tmp', 'tailored.db')
      : path.join(resolveDir(null, 'data'), isProd ? 'tailored.db' : 'tailored-dev.db'),
  storage: {
    root: storageDir,
    gowns: isVercel ? path.join(storageDir, 'gowns') : resolveDir(path.join(storageDir, 'gowns'), 'storage/gowns'),
    private: isVercel ? path.join(storageDir, 'private') : resolveDir(path.join(storageDir, 'private'), 'storage/private'),
  },
  // Behind a reverse proxy (Nginx, Render, Fly, Vercel…) set TRUST_PROXY=1 so secure cookies and IPs work.
  trustProxy: process.env.TRUST_PROXY || isVercel || false,
  sessionDays: Number(process.env.SESSION_DAYS) || 14,
  timezone: 'Asia/Manila',
  upload: {
    maxBytes: (Number(process.env.UPLOAD_MAX_MB) || 12) * 1024 * 1024,
    maxFiles: 8,
  },
  // Optional local background removal (https://github.com/danielgatis/rembg, MIT).
  // Path to the rembg executable; when unset the studio hides the button.
  rembgPath: process.env.REMBG_PATH || '',
};

module.exports = config;
