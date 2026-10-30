# Agents API

A local HTTP API that runs the DMG Studio agents (the files in `.claude/agents/`) through the Claude Agent SDK. Each run starts that agent as its own session in the project folder with its own tool list, streams its progress, and keeps the result.

```bash
cd tools/agents-api
npm install
cp .env.example .env     # set ANTHROPIC_API_KEY (and AGENTS_API_TOKEN)
npm start                # http://127.0.0.1:4800
```

It listens on `127.0.0.1` only. Every call except `/health` needs `Authorization: Bearer <AGENTS_API_TOKEN>`.

## Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/health` | `{ ok: true }`, no token needed. |
| `GET` | `/agents` | All agents: `name, description, tools, model, standby`. Re-read from disk on every call. |
| `GET` | `/agents/:name` | One agent, including its prompt. |
| `POST` | `/agents/:name/run` | Start a run. Body: `{ task, maxTurns?, confirm? }`. Returns `202 { run }`. Agents on standby need `"confirm": true`. At most 3 runs at once (`429` beyond that). |
| `GET` | `/runs` | All runs of this server session, newest first. |
| `GET` | `/runs/:id` | A run with its events and result. |
| `GET` | `/runs/:id/events` | Server-sent events: past events first, then live ones, ending with `{ type: "done" }`. |
| `POST` | `/runs/:id/cancel` | Stop a running agent. |

Run statuses: `running`, `completed`, `failed`, `cancelled`. Event types: `started`, `text`, `tool` (tool name and short input), `done`. Finished runs are also saved to `tools/agents-api/runs/` (git ignores it).

Example:

```bash
curl -H "Authorization: Bearer $TOKEN" -X POST http://127.0.0.1:4800/agents/project-planner/run \
  -d '{"task":"Plan SMS confirmations for confirmed bookings"}'
```

## Safety

- Agents only get the tools listed in their file. Read-only agents (planner, reviewer, GitHub) cannot edit files.
- Unattended runs are denied `git push`, `gh pr merge`, `rm -rf`, `.env` and `data/*.db` access, whatever the agent's prompt says.
- File edits are auto-approved for agents that can write. Review `git diff` after a run.
- Run history and `.env` are not committed.
- Agent definitions live in `.claude/agents/`. Commit that folder if teammates should get the same agents.
