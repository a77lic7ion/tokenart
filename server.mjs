/*
 * Token City — static server + collect API
 * Serves the procedural city files directly, no build step.
 * GET/POST /api/collect -> run collect-usage.py -> return usage.json
 *
 * Listens on every real address this machine has (loopback + LAN + Tailscale) on ONE port,
 * so the same URL works from this desktop, from a phone on the LAN, and from a phone on
 * Tailscale. It still never binds 0.0.0.0: each address is bound explicitly, so a new
 * interface that appears later is not silently exposed.
 *
 * Override the whole list with HOSTS=192.168.1.79,100.74.139.124
 */
import http from 'node:http';
import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT) || 8221;

// Every IPv4 address this machine actually holds. Explicit, never 0.0.0.0.
function localAddresses() {
  const found = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) found.push(a.address);
    }
  }
  return [...new Set(found)];
}

const HOSTS = (process.env.HOSTS
  ? process.env.HOSTS.split(',')
  : ['127.0.0.1', ...localAddresses()]
).map((s) => s.trim()).filter(Boolean);

// Don't hardcode the interpreter: /usr/bin/python3 is not guaranteed to exist or to be the
// python that has this project's stdlib. Resolve in order, and allow an override.
const PYTHON = process.env.CITY_PYTHON || (existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3');

// The collector reads provider keys from the environment. Loading them here means `node
// server.mjs` works on its own, without having to source anything first. Values are only
// ever handed to the child process — never logged, never returned over HTTP.
function loadEnvFile(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch { /* no env file, fine */ }
  return out;
}
const FILE_ENV = loadEnvFile(join(homedir(), '.hermes', '.env'));
const CHILD_ENV = { ...FILE_ENV, ...process.env };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.py': 'text/x-python; charset=utf-8',
};

function apiJson(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(payload));
}

function runCollect() {
  return new Promise((resolve, reject) => {
    const p = spawn(PYTHON, ['collect-usage.py'], { cwd: ROOT, timeout: 180000, env: CHILD_ENV });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d.toString(); });
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('close', (code) => {
      resolve({ code, stdout: stdout.slice(-3000), stderr: stderr.slice(-3000) });
    });
    p.on('error', reject);
  });
}

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/collect' && (req.method === 'GET' || req.method === 'POST')) {
    try {
      const result = await runCollect();
      let usage = null;
      try { usage = JSON.parse(await readFile(join(ROOT, 'usage.json'), 'utf8')); } catch { /* ignore */ }
      apiJson(res, 200, {
        ok: result.code === 0,
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        usage,
      });
    } catch (e) {
      apiJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  if (url.pathname === '/api/health') {
    apiJson(res, 200, { ok: true, port: PORT, hosts: HOSTS });
    return;
  }

  try {
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/procedural-city-demo.html';
    const fullPath = normalize(join(ROOT, path));
    if (!fullPath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const data = await readFile(fullPath);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(fullPath)] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not Found');
  }
};

// One listener per address, all sharing the handler. A failure on one address (Tailscale
// down, interface gone) must not take the others with it.
const listening = [];
for (const host of HOSTS) {
  const s = http.createServer(handler);
  s.on('error', (e) => {
    console.error(`  ${host}:${PORT} — could not bind (${e.code})`);
  });
  s.listen(PORT, host, () => {
    listening.push(host);
    console.log(`  http://${host}:${PORT}/procedural-city-demo.html`);
  });
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
console.log(`Token City + collect API — port ${PORT}`);