import { spawn } from 'node:child_process';
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env without requiring an extra package. This works on Windows and macOS/Linux.
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const raw of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

const node = process.execPath;
const viteScript = path.join(__dirname, 'node_modules', 'vite', 'bin', 'vite.js');
const children = new Set();
let shuttingDown = false;

async function mysqlPreflight() {
  const host = process.env.DB_HOST || '127.0.0.1';
  const port = Number(process.env.DB_PORT || 3306);
  // On Windows, try common MySQL/MariaDB services before starting the API.
  // This is best-effort only; it never blocks the web app from starting.
  if (process.platform === 'win32' && (host === '127.0.0.1' || host === 'localhost')) {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    for (const service of ['MySQL80','MySQL84','MySQL82','MySQL81','MySQL57','MariaDB','mariadb']) {
      try {
        const q = await execFileAsync('sc.exe', ['query', service], { windowsHide: true });
        if (/SERVICE_NAME/i.test(q.stdout || '')) {
          if (!/STATE\s*:\s*4\s+RUNNING/i.test(q.stdout || '')) {
            try { await execFileAsync('sc.exe', ['start', service], { windowsHide: true }); } catch {}
          }
          break;
        }
      } catch {}
    }
  }
  // Give a just-started Windows service a moment to bind the port.
  for (let i = 0; i < 15; i++) {
    try {
      const net = await import('node:net');
      await new Promise((resolve, reject) => {
        const sock = net.createConnection({host, port});
        sock.once('connect', () => { sock.destroy(); resolve(); });
        sock.once('error', reject);
        sock.setTimeout(500, () => { sock.destroy(); reject(new Error('timeout')); });
      });
      console.log(`MySQL preflight: ${host}:${port} is reachable.`);
      return true;
    } catch { await new Promise(r => setTimeout(r, 400)); }
  }
  console.warn(`MySQL preflight: ${host}:${port} is not reachable. The API will start, but database operations will fail until MySQL is running and .env credentials are correct.`);
  return false;
}

function start(label, args) {
  // IMPORTANT: do not spawn npm.cmd with shell:false on Windows.
  // Node can throw EINVAL when spawning a .cmd shim from some Windows/OneDrive paths.
  const child = spawn(node, args, {
    cwd: __dirname,
    stdio: 'inherit',
    shell: false,
    windowsHide: false,
    env: process.env
  });
  children.add(child);
  child.on('error', err => console.error(`[${label}] failed to start: ${err.message}`));
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (shuttingDown) return;
    if (signal) console.log(`[${label}] stopped (${signal})`);
    else if (code !== 0) console.error(`[${label}] stopped with code ${code}`);
  });
  return child;
}

console.log('Starting Trifolia. MySQL is optional in local mode...');

console.log('Starting Trifolia shared API server on port 3001...');
start('API', [path.join(__dirname, 'server.js')]);

console.log('Starting Trifolia web application on port 5173...');
start('WEB', [viteScript, '--host', '0.0.0.0', '--port', '5173']);

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try { child.kill(); } catch {}
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGBREAK', shutdown);
process.on('exit', shutdown);
