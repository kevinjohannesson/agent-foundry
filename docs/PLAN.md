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
  A Claude Project may take this role instead; see below. Decided before M3.
- **Waiting on you:** foundry-launched sessions get MCP tools `ask(question, options)`, `done(summary)` and `message(to, text)`.
  For any other session a turn ending means "your move", and a Notification means "needs you".
- **Identity:** every session has a short name and a two-letter monogram, unique per workstream. Ticket ids are optional metadata (Alt shows them).
  Controllers name what they propose; otherwise the first prompt names it until you rename it.
- **Bots** are subagents (PreToolUse/PostToolUse on Task). **Layout, pins and areas** are core state, so placement survives restarts.
- **Archive** is core state: nothing disappears unless you archive it. Handoffs are written to `.foundry/handoffs/`.
- **Claude Projects (beta, noted 22 Nov):** one coordinator chat that starts worker threads with shared instructions and
  memory, and an Overview of which threads need you ([docs](https://code.claude.com/docs/en/claude-projects)). It overlaps
  our controllers (M3), lifecycle (M4) and PR belts (v0.5). We can't build on it yet:
  - It has no API, and it isn't available in the CLI or VS Code.
  - Cloud threads don't run local hooks or write local transcripts, so the core can't see them.
  - Threads a project runs on this machine through Remote Control do fire our hooks.

  M1 and M2 go ahead unchanged, with workstreams built so that one can later be linked to a Project. Before M3, run a test:
  create a project, have it run one thread on this machine, and check what the core records. If project threads can be told
  apart, a Project can be a workstream's controller and M3 shrinks to showing it. An API, or threads running locally by
  default, would push further that way.

  **Test run (22 Nov).** A thread in a Claude Project started a read-only Remote Control run in the project's folder on this
  machine, with one Explore subagent. It reached the factory's Unassigned lot, so hooks from such runs do arrive. Gaps:
  - It can't be told apart yet: it reported `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, the same as any desktop session.
    Next, read that session's transcript (`acc912c0-…`) for anything project-specific, such as `bridge-session` lines.
  - It showed as `New Session`, so it wrote no title line the tailer reads.
  - It seemed to leave the factory within a minute or so. Check whether it turned grey or ghost hiding dropped it.
  - Only the local run shows. The project's coordinator and its threads still run in the cloud and stay invisible.

  The remote sessions API that Claude's own session tools use returns a session's title, status (working, blocked,
  review ready, done, failed), a needs-action summary and, for a thread, its coordinator (`parent_session_id`). That maps
  well onto a workstream with its controller, but it needs a claude.ai sign-in, and its account listing left out the
  project's sessions. Not something to build on yet.

  **Decision:** Agent Foundry is a playground with no deadline, so we don't change how Projects are used to make them show
  here. Wait for Projects to run threads on this machine, then run this test again.

## Milestones
| | What | Done when |
|---|---|---|
| M0 Spike | `pnpm spike` + an hour of recorded hooks (docs/SPIKE.md) | We know the real event shapes for CLI, VS Code and desktop |
| M1 Core, read-only | Daemon, hook forwarder, transcript tailer, projector, table view | Replayed transcripts and spool show correct states, and a scripted live checklist passes |
| M2 Factory on real data | Port the mockup to React + PixiJS; Unassigned lot; drag to assign; persisted layout | You'd rather look at this than the session list |
| M3 Controllers | foundry-mcp, proposals into the inventory, placing launches a session, answers from the panel, messages, bots | One ticket from proposal to done, entirely in the game |
| M4 Lifecycle | Chest, handoffs, restore, chains, manual/auto | A 3-ticket chain runs end to end |
| v0.5 | PR belts, CI jams, held stacks, Forgejo platform, merge train, arrays | |
| Later | Space as its own view, belts you place, PR square drill-down, resizable/nested areas, other renderers, remote access | |

## Status
- [x] Monorepo, protocol, projector, core daemon (HTTP + WebSocket + spool), hook forwarder and installer, spike script. 16 tests.
- [x] M0 spike run on your machine (findings and gaps in docs/SPIKE.md)
- [x] Transcript tailer and table view (M1 build). The table is at http://127.0.0.1:7717. Checked against this machine's
  transcripts with hooks off: 16 sessions from the last 24h, with app, title, workflow agents and transcript-derived status.
- [x] M1 replay (`pnpm replay`): the 826 spooled spike hook events and the transcripts written alongside them, replayed on a
  simulated clock through the real tailer, core and projector (236 files, about 20 s). Checks: every event parses; state
  stays consistent; ghosts stay hidden; status matches the hooks unless the transcript is newer, and the transcript
  otherwise; no flicker between the two; restart rebuilds the same state and records nothing. It found and fixed: ghosts
  deleted before their transcript was read (a closed session came back as "your move"), "status from" stuck on transcript
  after a Stop, and prompts injected by other sessions taking the place of yours. Local only; nothing from it is committed.
- [x] M1 live checklist: [docs/M1-CHECKLIST.md](M1-CHECKLIST.md). First run 20 Nov: 3 misses (background subagents, an
  early interrupt, a noisy Ctrl+C), all fixed and checked by replaying that run. Re-run of checks 3 and 7 on 22 Nov passed;
  the agent's details now show in the table, since the tooltip couldn't survive the redraws. **M1 is done.**
- Passive soak, after M1: hooks stay installed during normal work. A wrong state becomes a bug to fix; M1 doesn't wait on it.
- [x] M2 build (22 Nov): the factory view, `apps/factory` (Vite, React panels over a PixiJS map), served by the core at
  http://127.0.0.1:7717/factory (`pnpm build:factory`; `pnpm dev:factory` for hot reload). The table stays at `/`.
  - From the mockup: the map (pan, zoom, Fit), workstream areas with colour and shape, sessions as machines (spinning
    while working, amber on your move, red when they need you, hollow when idle, grey when ended), running subagents and
    workflow agents as bots, the overview, the inspector, alerts, the hotbar (pinned sessions, keys 1-0), tooltips, Alt
    for titles, and the legend. New: the Unassigned lot, New workstream, moving and resizing areas, and a chest per area
    (archive and restore; handoffs stay M4). Left for later: hubs, proposals, inventory, Auto, messages (M3); chains and
    arrays (M4); belts, train, silo and the remote (v0.5).
  - Protocol: workstreams have a shape and a `link` (null for now: a Claude Project can be linked later without changing
    the state's shape). The lot (`state.lot`) and the hotbar (`state.pins`) are state. A session's position is relative
    to its area, so moving an area carries its sessions; unplaced sessions are packed by `layout.ts`, which the core
    (to check intents) and the factory (to draw) share. New events `workstream.updated`, `workstream.removed`,
    `area.set` and `pin.set`; `session.assigned` can carry a spot. New intents `updateWorkstream`, `removeWorkstream`,
    `setArea` and `pin`; `assign` takes a spot and `createWorkstream` finds room itself. The core refuses a spot outside
    the area, one on top of another session, and areas closer than 2 tiles, with a message the factory shows.
  - Checked: 78 tests (layout, projector, intents, a restart rebuilding the layout, the factory's drop and area plans)
    plus the M1 replay. In the browser against a second core on this machine's transcripts: drag to assign, move within an
    area, move and resize areas, pin, archive and restore, refusals, needs-you and bots (from posted hook events), phone
    width, and the same layout after a core restart.
- [ ] M2 done when you'd rather look at the factory than the session list. Use it for a while and say what's missing.
- [x] Claude Projects test, first run 22 Nov (see Decisions): a local Remote Control run shows, but can't be told apart yet.
- [ ] Before M3: re-run the Projects test once Projects run threads locally, then decide what a controller is
