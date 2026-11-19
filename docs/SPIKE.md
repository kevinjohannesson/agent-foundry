# M0 spike: what does Claude Code record on this machine?

Goal: find out, with real data, what the hooks and transcripts give us before building on them.
About 20 minutes of your attention plus an hour of normal work.

1. **Install**
   ```bash
   pnpm install
   ```
2. **Scan the transcripts you already have**
   ```bash
   pnpm spike
   ```
3. **Record hook events while you work.** This adds hooks that only append to
   `~/.agent-foundry/spool.jsonl`; nothing else changes. A backup of your settings is written first.
   ```bash
   pnpm hooks:install --spool-only
   ```
   Then work normally for about an hour. Try to include:
   - a session in the CLI, one in VS Code and one in the desktop app
   - a session that uses a subagent
   - a permission prompt you have to answer
   - leaving a session idle until Claude Code nudges you

   Then remove the hooks:
   ```bash
   pnpm hooks:uninstall
   ```
4. **Scan again** and paste `fixtures/spike-report.json` to Claude.
   ```bash
   pnpm spike
   ```

## Questions the report answers
- Do CLI, VS Code and desktop sessions all write transcripts to `~/.claude/projects`, and can we tell them apart?
- How do subagents show up: inside the parent transcript, in their own files, or both?
- Which hook events fire, in what order, and with which fields?
- What do notifications look like (permission prompt vs. idle reminder)?
- Is token usage in the transcripts, so the panels can show it?

## Findings (19 Nov 2026)
One run: 97 sessions on disk, plus about 80 minutes of hooks from 14 sessions
(7 desktop, 2 VS Code, 1 CLI, 4 that never wrote a transcript).

### Transcripts
- **Layout** under `~/.claude/projects/<project>/`:
  - `<sessionId>.jsonl`: the session
  - `<sessionId>/subagents/agent-<id>.jsonl`: a subagent, with `agent-<id>.meta.json`
    (`agentType`, `description`, `toolUseId`, `spawnDepth`, sometimes `finished`) and `agent-<id>.prefix.json` (cache diagnostics)
  - `<sessionId>/subagents/workflows/wf_<id>/agent-<id>.jsonl`: a workflow agent. Its meta has `workflowPhase` and no `toolUseId`;
    the run is in `<sessionId>/workflows/wf_<id>.json` and `wf_<id>/journal.jsonl` (`launched`, `started`, `result`)
  - `<sessionId>/custom-title.json`, `<sessionId>/tool-results/toolu_<id>.json`
- **Which app:** every session file has `entrypoint` in its first few lines: `claude-desktop`, `claude-vscode`, `cli` or `sdk-cli`.
  Hook payloads don't carry it, so the core reads it from the transcript.
- **Subagents link back reliably:** the folder name is the parent's session id, their lines carry the same `sessionId` with
  `isSidechain: true`, and the meta `toolUseId` is the parent's `Agent` tool_use id (20 of 20 sampled).
- **Titles differ by app:** desktop writes `custom-title` and `agent-name` lines; VS Code and the CLI write `ai-title`. All write `last-prompt`.
- **Usage:** every assistant line has `message.usage` (input, output, cache and thinking tokens). `cost-state` lines add
  per-model cost, durations and lines added/removed.
- **Formats vary by version:** the CLI on 2.1.150 writes `permission-mode` where newer versions write `mode`. VS Code ran older
  versions (2.1.251–2.1.318) than desktop (2.1.317–2.1.325). Parse defensively and skip unknown line types.
- **App-specific lines:** `pr-link` (PR number, repo, URL) appears in all three. Desktop alone writes `bridge-session` and `frame-link`;
  VS Code writes `worktree-state` and `session-owner`.
- **Sessions can move:** a desktop session that changes folder gets `relocated` lines, and its file moves to the new `<project>`
  folder under the same name. The old path disappears, and hooks report the new `transcript_path` from then on.

### Hooks
- **Common fields:** `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`, `prompt_id`, `effort.level`,
  and `scratchpad_dir` (desktop). Timestamps in the spool are epoch milliseconds.
- **Tool calls:** `tool_use_id` pairs PreToolUse with PostToolUse. Calls inside a subagent carry `agent_id` and `agent_type`,
  MCP calls carry `mcp_server`, and PostToolUse has `duration_ms`. 5 of 340 calls had no PostToolUse: a session archiving
  itself (3) and Bash (2), most likely failures, which fire `PostToolUseFailure` instead (not installed for this run).
  The projector has to close open calls at Stop or SessionEnd.
- **Stop** carries `last_assistant_message`, `background_tasks`, `session_crons` and `stop_hook_active`.
- **SubagentStop:** only 6 of 54 were real subagents (`agent_type` set, `agent_transcript_path` exists). The other 48 have an
  empty `agent_type` and no transcript, and mostly follow a Stop: internal agents. Ignore them.
- **UserPromptSubmit** carries `prompt` and usually `session_title`.
- **SessionStart** `source` is `startup` or `resume`; opening a desktop session is always `resume`. Resumes also carry
  `context_tokens`, `seconds_since_last_response`, `prompt_cache_likely_expired` and `estimated_cache_write_usd`.
  **SessionEnd** `reason` was always `other`.
- **Ghost sessions:** 3 sessions were SessionStart → SessionEnd within seconds and never wrote a transcript (pre-warmed).
  A session should only appear once it has a prompt or a transcript.
- **Notifications** carry `notification_type`. We saw `idle_prompt` (CLI only) and `auth_success`. Desktop and VS Code sent
  none, so for them "your move" has to come from Stop. There was no `permission_prompt`, because every event ran in `auto` mode.
- **Hot reload:** running desktop sessions picked up the installed hooks immediately, despite what the installer says.

### Gaps before M1
- ~~The installer registered 9 of the 33 hook events.~~ It now also registers `SubagentStart`, `PostToolUseFailure`,
  `StopFailure`, `PermissionRequest`, `PermissionDenied`, `CwdChanged` and `PostCompact` (16 in all). The projector handles
  `StopFailure` and `PostToolUseFailure`; the rest are recorded, and none were in this run.
- Permission prompts are unobserved because everything ran in auto mode, and VS Code had only 2 short sessions in the hook window.
