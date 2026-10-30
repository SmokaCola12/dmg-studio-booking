// Runs one agent as a Claude Agent SDK session and records its events.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const MAX_EVENTS = 500;

// Agents run unattended, so dangerous commands and secrets stay off limits.
const DENIED = [
  'Bash(git push:*)',
  'Bash(git reset --hard:*)',
  'Bash(rm -rf:*)',
  'Bash(gh pr merge:*)',
  'Read(./.env)',
  'Read(./.env.*)',
  'Read(./data/*.db)',
  'Edit(./.env)',
  'Edit(./data/*.db)',
];

const brief = (input) => {
  const s = typeof input === 'string' ? input : JSON.stringify(input ?? {});
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
};

function toEvents(msg) {
  const out = [];
  if (msg.type === 'system' && msg.subtype === 'init') {
    out.push({ type: 'started', sessionId: msg.session_id, model: msg.model });
  } else if (msg.type === 'assistant') {
    for (const b of msg.message?.content ?? []) {
      if (b.type === 'text' && b.text.trim()) out.push({ type: 'text', text: b.text });
      else if (b.type === 'tool_use') out.push({ type: 'tool', tool: b.name, input: brief(b.input) });
    }
  }
  return out;
}

export function createRunner({ projectDir, runsDir, maxConcurrent = 3 }) {
  const runs = new Map();
  const listeners = new Map();

  const emit = (run, event) => {
    const e = { at: Date.now(), ...event };
    if (run.events.length < MAX_EVENTS) run.events.push(e);
    for (const fn of listeners.get(run.id) ?? []) fn(e);
  };

  const view = (run, withEvents = false) => ({
    id: run.id,
    agent: run.agent,
    task: run.task,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    result: run.result ?? null,
    error: run.error ?? null,
    costUsd: run.costUsd ?? null,
    turns: run.turns ?? null,
    ...(withEvents ? { events: run.events } : { eventCount: run.events.length }),
  });

  async function execute(run, agent, maxTurns) {
    const abortController = run.abort;
    const canWrite = agent.tools.some((t) => ['Edit', 'Write'].includes(t));
    try {
      const stream = query({
        prompt: run.task,
        options: {
          cwd: projectDir,
          abortController,
          maxTurns,
          systemPrompt: { type: 'preset', preset: 'claude_code', append: agent.prompt },
          tools: agent.tools,
          allowedTools: agent.tools,
          disallowedTools: DENIED,
          permissionMode: canWrite ? 'acceptEdits' : 'default',
          // 'user' lets user-level hooks fire (for example the Pixel Agents extension).
          settingSources: ['user', 'project'],
          ...(agent.model ? { model: agent.model } : {}),
        },
      });
      for await (const msg of stream) {
        for (const e of toEvents(msg)) emit(run, e);
        if (msg.type === 'result') {
          run.result = msg.result ?? null;
          run.costUsd = msg.total_cost_usd ?? null;
          run.turns = msg.num_turns ?? null;
          run.status = msg.subtype === 'success' ? 'completed' : 'failed';
          if (run.status === 'failed') run.error = msg.subtype;
        }
      }
      if (run.status === 'running') run.status = abortController.signal.aborted ? 'cancelled' : 'completed';
    } catch (err) {
      run.status = abortController.signal.aborted ? 'cancelled' : 'failed';
      run.error = abortController.signal.aborted ? null : String(err?.message ?? err);
    } finally {
      run.endedAt = Date.now();
      emit(run, { type: 'done', status: run.status });
      try {
        fs.mkdirSync(runsDir, { recursive: true });
        fs.writeFileSync(path.join(runsDir, `${run.id}.json`), JSON.stringify(view(run, true), null, 2));
      } catch {
        /* history is best effort */
      }
    }
  }

  return {
    start(agent, task, { maxTurns = 30 } = {}) {
      const active = [...runs.values()].filter((r) => r.status === 'running').length;
      if (active >= maxConcurrent) return { error: `Too many runs at once (limit ${maxConcurrent}). Wait for one to finish.`, code: 429 };
      const run = {
        id: crypto.randomUUID(),
        agent: agent.name,
        task,
        status: 'running',
        startedAt: Date.now(),
        events: [],
        abort: new AbortController(),
      };
      runs.set(run.id, run);
      execute(run, agent, maxTurns);
      return { run: view(run) };
    },
    list: () => [...runs.values()].sort((a, b) => b.startedAt - a.startedAt).map((r) => view(r)),
    get: (id) => (runs.has(id) ? view(runs.get(id), true) : null),
    cancel(id) {
      const run = runs.get(id);
      if (!run) return null;
      if (run.status === 'running') run.abort.abort();
      return view(run);
    },
    // Replays past events, then streams new ones. Returns an unsubscribe function.
    subscribe(id, fn) {
      const run = runs.get(id);
      if (!run) return null;
      run.events.forEach(fn);
      if (run.status !== 'running') return () => {};
      const set = listeners.get(id) ?? new Set();
      set.add(fn);
      listeners.set(id, set);
      return () => set.delete(fn);
    },
  };
}
