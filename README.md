# Agent Foundry

A factory-game view of your Claude Code sessions. Workstreams are areas on a map, controllers are hubs,
sessions are machines you place, subagents fly out as bots, and finished PRs ride belts to a merge train.

The game is only a renderer. Underneath is a local core that turns Claude Code hook events into an
append-only event log and a projected state; any renderer (this factory, a plain table, something 3D later)
reads that state and sends back intents.

Mockup: https://claude.ai/artifact/EwWyPRH6eNjjRuTvq8d9bt · Plan: [docs/PLAN.md](docs/PLAN.md) · First step: [docs/SPIKE.md](docs/SPIKE.md)

## Layout
| Path | What |
|---|---|
| `packages/protocol` | Events, state, intents (Zod) and the projector. The contract every renderer uses. |
| `packages/hook` | `foundry-hook`, the forwarder Claude Code calls for every hook event, plus the settings installer. |
| `apps/core` | The daemon: Hono HTTP + WebSocket on `127.0.0.1:7717`, SQLite event log via Drizzle, transcript tailer, and the table view (`public/index.html`). |
| `tools/spike` | M0 spike: reports what this machine's Claude Code records, as structure and counts only. |
| `apps/factory` | The game (React + PixiJS). Next milestone. |

## Run
```bash
pnpm install
pnpm test
pnpm dev:core          # starts the core; data lives in ~/.agent-foundry
pnpm hooks:install     # forwards every Claude Code hook event to the core (backs up settings first)
pnpm hooks:uninstall   # removes only what hooks:install added
pnpm replay            # replays your recorded spool and transcripts through the core and checks the states (local data only)
```
Then open http://127.0.0.1:7717 for the table view (`/state` has the raw JSON). Desktop-app sessions pick up the hooks
right away; restart a CLI or VS Code session to load them. Until then, its status comes from its transcript.

The core also reads transcripts under `~/.claude/projects`: which app runs a session, its title, subagents and workflow
agents, and the status of sessions that send no hooks. Settings, all optional:

| Variable | Default | What |
|---|---|---|
| `FOUNDRY_HOME` | `~/.agent-foundry` | Event log and spool |
| `FOUNDRY_PORT` | `7717` | Core port |
| `FOUNDRY_TRANSCRIPTS` | `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects` | Where transcripts live |
| `FOUNDRY_BACKFILL_HOURS` | `24` | Sessions touched this recently are read on start; older ones once a hook names them |

## Guarantees
- The hook forwarder never blocks or fails a Claude Code session: 400 ms timeout, always exits 0, prints nothing.
- If the core is down or slow, events go to `~/.agent-foundry/spool.jsonl`. The core picks them up every 2 seconds
  and on start, and skips copies of events it already has.
- The core only reads transcripts; it never writes to `~/.claude`.
- Everything stays on this machine. The core listens on 127.0.0.1 only.
