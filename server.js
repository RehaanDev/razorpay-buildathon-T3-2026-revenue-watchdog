import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './src/config.js';
import { store } from './src/store.js';
import { seed } from './src/seed/generator.js';
import { fitModel } from './src/pipeline/model.js';
import { runCycle } from './src/pipeline/cycle.js';
import { route } from './src/routes/api.js';
import { razorpay } from './src/razorpay/client.js';
import { resolveDriver } from './src/agent/loop.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const query = Object.fromEntries(url.searchParams);

  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

  const raw = req.method === 'GET' ? '' : await readBody(req);
  let parsed = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  try {
    const result = await route(req.method, url.pathname, query, parsed, raw, req.headers);
    res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result.body));
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

async function boot() {
  const t0 = Date.now();

  // Load policy from previous run first (so the policy the operator set
  // survives a restart).
  store.loadPolicy();

  // Seed synthetic background traffic if enabled.
  let s = { payments: 0 };
  if (config.syntheticTraffic) {
    s = seed();
  } else {
    // Still need a clock for the pipeline.
    store.meta.clock = new Date().toISOString();
    store.meta.seededAt = store.meta.clock;
  }

  // Reload real payments on top of synthetic traffic (or in place of it).
  // This means a real payment you made yesterday is still in the leak map
  // today, even if you restarted the server.
  const real = store.loadReal();

  const model = fitModel();
  const summary = await runCycle({});

  const driver = resolveDriver();
  const agentLabel =
    driver === 'gemini' ? `Gemini (${config.geminiModel})` :
    driver === 'claude' ? `Claude (${config.anthropicModel})` :
    'deterministic (no model key set)';

  console.log('');
  console.log('  Revenue Watchdog  v3');
  console.log('  ────────────────────────────────────────────────────────');
  console.log(`  Gateway          ${razorpay.mode().toUpperCase()}${
    razorpay.mode() === 'mock'
      ? '  ← set RAZORPAY_MODE=live for real Razorpay calls'
      : `  (key: ${config.razorpayKeyId.slice(0, 14)}…)`
  }`);
  console.log(`  Agent            ${agentLabel}`);
  if (config.syntheticTraffic) {
    console.log(`  Synthetic data   ${s.payments.toLocaleString('en-IN')} payments across 6 merchants`);
  } else {
    console.log('  Synthetic data   OFF (real-only mode)');
  }
  if (real.payments > 0) {
    console.log(`  Real payments    ${real.payments} reloaded from disk, ${real.actions} actions`);
  } else {
    console.log('  Real payments    none yet — buy something on the storefront');
  }
  console.log(`  Model            Brier ${model.brier.toFixed(4)}, skill ${(model.skillScore * 100).toFixed(1)}% (${model.testedOn} rows held out)`);
  console.log(`  Investigations   ${summary.investigations.length}`);
  console.log(`  Recovery queue   ${Object.values(summary.safety.verdicts).reduce((a, b) => a + b, 0)} candidates  ${JSON.stringify(summary.safety.verdicts)}`);
  console.log(`  Boot             ${Date.now() - t0}ms`);
  console.log('  ────────────────────────────────────────────────────────');
  console.log(`  Storefront       http://localhost:${config.port}/store.html`);
  console.log(`  Watchdog UI      http://localhost:${config.port}`);
  if (razorpay.mode() === 'live') {
    console.log('');
    console.log('  Webhook endpoint  POST /api/razorpay/webhook');
    console.log('  ⚡  Expose this with:  npx cloudflared tunnel --url http://localhost:' + config.port);
    console.log('  Then set https://<your-tunnel>/api/razorpay/webhook in the Razorpay dashboard');
  }
  console.log('');

  server.listen(config.port);
}

boot();
