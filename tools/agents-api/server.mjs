// Agents API: run the .claude/agents team over local HTTP.
//   cd tools/agents-api && npm install && npm start
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgents, publicAgent } from './lib/registry.mjs';
import { createRunner } from './lib/runner.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(here, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const projectDir = path.resolve(process.env.AGENTS_PROJECT_DIR || path.join(here, '..', '..'));
const agentsDir = path.join(projectDir, '.claude', 'agents');
const PORT = Number(process.env.AGENTS_API_PORT) || 4800;

let TOKEN = process.env.AGENTS_API_TOKEN;
let generated = false;
if (!TOKEN) {
  TOKEN = crypto.randomBytes(24).toString('hex');
  generated = true;
}

const runner = createRunner({
  projectDir,
  runsDir: path.join(here, 'runs'),
  maxConcurrent: Number(process.env.AGENTS_MAX_CONCURRENT) || 3,
});

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const authorized = (req) => {
  const h = req.headers.authorization || '';
  const given = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
  const want = Buffer.from(TOKEN);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 100_000) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('bad json'));
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  if (method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
  if (!authorized(req)) return send(res, 401, { error: 'Missing or wrong bearer token.' });

  // The registry is re-read each request so edits to .claude/agents show up without a restart.
  const agents = loadAgents(agentsDir);
  const find = (name) => agents.find((a) => a.name === name);

  try {
    if (method === 'GET' && url.pathname === '/agents') return send(res, 200, { agents: agents.map(publicAgent) });

    if (parts[0] === 'agents' && parts[1] && method === 'GET' && parts.length === 2) {
      const a = find(parts[1]);
      return a ? send(res, 200, { agent: a }) : send(res, 404, { error: 'No such agent.' });
    }

    if (parts[0] === 'agents' && parts[2] === 'run' && method === 'POST') {
      const agent = find(parts[1]);
      if (!agent) return send(res, 404, { error: 'No such agent.' });
      const body = await readJson(req);
      const task = typeof body.task === 'string' ? body.task.trim() : '';
      if (!task || task.length > 8000) return send(res, 400, { error: 'Send a "task" of 1 to 8000 characters.' });
      if (agent.standby && body.confirm !== true) {
        return send(res, 409, { error: `${agent.name} is on standby. Send "confirm": true to run it anyway.` });
      }
      const maxTurns = Number.isInteger(body.maxTurns) ? Math.min(Math.max(body.maxTurns, 1), 100) : undefined;
      const out = runner.start(agent, task, { maxTurns });
      return out.error ? send(res, out.code, { error: out.error }) : send(res, 202, { run: out.run });
    }

    if (method === 'GET' && url.pathname === '/runs') return send(res, 200, { runs: runner.list() });

    if (parts[0] === 'runs' && parts[1]) {
      if (method === 'GET' && parts.length === 2) {
        const r = runner.get(parts[1]);
        return r ? send(res, 200, { run: r }) : send(res, 404, { error: 'No such run.' });
      }
      if (method === 'POST' && parts[2] === 'cancel') {
        const r = runner.cancel(parts[1]);
        return r ? send(res, 200, { run: r }) : send(res, 404, { error: 'No such run.' });
      }
      if (method === 'GET' && parts[2] === 'events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        const unsubscribe = runner.subscribe(parts[1], (e) => {
          res.write(`data: ${JSON.stringify(e)}\n\n`);
          if (e.type === 'done') res.end();
        });
        if (!unsubscribe) {
          res.end();
          return;
        }
        req.on('close', unsubscribe);
        return;
      }
    }

    send(res, 404, { error: 'Not found.' });
  } catch (err) {
    send(res, err.message === 'bad json' || err.message === 'too large' ? 400 : 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[agents-api] http://127.0.0.1:${PORT}  project: ${projectDir}`);
  console.log(`[agents-api] ${loadAgents(agentsDir).length} agents loaded from .claude/agents`);
  if (generated) console.log(`[agents-api] AGENTS_API_TOKEN not set. Temporary token for this run: ${TOKEN}`);
});
