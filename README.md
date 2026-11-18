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
| `apps/core` | The daemon: Hono HTTP + WebSocket on `127.0.0.1:7717`, SQLite event log via Drizzle. |
| `tools/spike` | M0 spike: reports what this machine's Claude Code records, as structure and counts only. |
| `apps/factory` | The game (React + PixiJS). Next milestone. |

## Run
```bash
pnpm install
pnpm test
pnpm dev:core          # starts the core; data lives in ~/.agent-foundry
pnpm hooks:install     # forwards every Claude Code hook event to the core (backs up settings first)
pnpm hooks:uninstall   # removes only what hooks:install added
```
Then `curl 127.0.0.1:7717/state` shows your sessions. New sessions pick up hooks when they start.

## Guarantees
- The hook forwarder never blocks or fails a Claude Code session: 400 ms timeout, always exits 0, prints nothing.
- If the core is down, events go to `~/.agent-foundry/spool.jsonl` and are ingested in order on the next start.
- Everything stays on this machine. The core listens on 127.0.0.1 only.
