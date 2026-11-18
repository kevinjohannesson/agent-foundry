# Agent Foundry v0 plan

## Principle
The core owns the truth. Renderers draw a typed state snapshot plus an event stream, and send intents back.
The factory is one renderer; a plain table and a future 3D view are others.

## Decisions (Nov 2026)
- **Stack:** TypeScript, pnpm workspaces. Core: Hono, Drizzle + SQLite (better-sqlite3), Zod. App: React + PixiJS (Vite). Tests: Vitest, Playwright.
- **Runs on:** your personal machine. Workplace constraints are a later concern.
- **Data sources:** Claude Code hooks (live), transcripts (detail and backfill), later git and Forgejo.
- **Launching:** sessions placed in the game are started by the core through the Agent SDK in a git worktree.
  Sessions started elsewhere appear in an Unassigned lot; drag them into a workstream to assign them.
  It's fine if game-launched sessions don't show in the desktop app; they resume from the CLI.
- **Controllers:** a controller is the main session of a workstream (the hub); sessions it proposes are its sub-sessions.
- **Waiting on you:** foundry-launched sessions get MCP tools `ask(question, options)`, `done(summary)` and `message(to, text)`.
  For any other session a turn ending means "your move", and a Notification means "needs you".
- **Identity:** every session has a short name and a two-letter monogram, unique per workstream. Ticket ids are optional metadata (Alt shows them).
  Controllers name what they propose; otherwise the first prompt names it until you rename it.
- **Bots** are subagents (PreToolUse/PostToolUse on Task). **Layout, pins and areas** are core state, so placement survives restarts.
- **Archive** is core state: nothing disappears unless you archive it. Handoffs are written to `.foundry/handoffs/`.

## Milestones
| | What | Done when |
|---|---|---|
| M0 Spike | `pnpm spike` + an hour of recorded hooks (docs/SPIKE.md) | We know the real event shapes for CLI, VS Code and desktop |
| M1 Core, read-only | Daemon, hook forwarder, transcript tailer, projector, table view | A day of real sessions shows correct states |
| M2 Factory on real data | Port the mockup to React + PixiJS; Unassigned lot; drag to assign; persisted layout | You'd rather look at this than the session list |
| M3 Controllers | foundry-mcp, proposals into the inventory, placing launches a session, answers from the panel, messages, bots | One ticket from proposal to done, entirely in the game |
| M4 Lifecycle | Chest, handoffs, restore, chains, manual/auto | A 3-ticket chain runs end to end |
| v0.5 | PR belts, CI jams, held stacks, Forgejo platform, merge train, arrays | |
| Later | Space as its own view, belts you place, PR square drill-down, resizable/nested areas, other renderers, remote access | |

## Status
- [x] Monorepo, protocol, projector, core daemon (HTTP + WebSocket + spool), hook forwarder and installer, spike script. 16 tests.
- [ ] M0 spike run on your machine
- [ ] Transcript tailer, table view (M1)
- [ ] Factory port (M2)
