# M1 live checklist

About 30–60 minutes. Each check is something you do in Claude Code and what the table at http://127.0.0.1:7717 should show.
Tick a check when it matches, and write a line under **Results** when it doesn't. Every miss is a bug to fix, not a reason to redo the run.

The table's columns: **Status**, **Session** (monogram, name and the app's title), **App**, **Folder**, **Now** (the notification
or last prompt), **Tools**, **Agents** (running / total), **Mode**, **Active** (time since last activity) and **Status from**
(hooks or transcript, whichever set the status last). Ended and archived sessions are hidden unless you tick those boxes.

## Setup
1. Start the core in its own terminal and leave it running:
   ```bash
   pnpm dev:core
   ```
   The first start also loads the 826 hook events the spike spooled on 18–19 Nov. Rows from then are expected.
2. Open http://127.0.0.1:7717. The pill at the top right should say **live**.
3. Install the hooks (backs up `~/.claude/settings.json` first):
   ```bash
   pnpm hooks:install
   ```
   Desktop sessions pick them up at once. CLI and VS Code sessions that were already open only do after a restart;
   until then their status comes from the transcript (**Status from: transcript**).

To see the raw events behind a row, newest first:
```bash
sqlite3 ~/.agent-foundry/foundry.db "select seq, datetime(ts/1000,'unixepoch','localtime'), json_extract(body,'$.payload.session_id'), coalesce(json_extract(body,'$.payload.hook_event_name'), json_extract(body,'$.type')) from events order by seq desc limit 30"
```

## Checks

### 1. Desktop: prompt, then finish
In the desktop app, start a new session in any folder and send a short prompt, for example "list the files here".
- [ ] No row appears for the new session before you send the prompt (empty pre-warmed sessions stay hidden)
- [ ] After sending: a row with **App** Desktop, **Status** Working, **Status from** hooks
- [ ] When the reply is done: **Your move**
- [ ] Once the app has named the session, **Session** shows that title

### 2. Permission prompt (the spike never saw one)
In a session in default permission mode ("Ask permissions"), ask for something that needs your approval, for example "run `ls -la` in a shell".
- [ ] While the approval prompt is up: **Needs you**, with the request in **Now**
- [ ] After you approve: back to **Working**, then **Your move**

If it stays on Working: the spike saw no Notification events from the desktop app, and the projector doesn't use
`PermissionRequest` yet. Note it under Results; that is the fix.

### 3. Subagent, then interrupt
Ask for something that starts a subagent, for example "use a subagent to find where the WebSocket server is set up".
- [ ] While the subagent runs: **Agents** 1 / 1 (hover it for the agent's type and description). Claude Code runs subagents
  in the background, so the turn may end while it works: **Your move** with 1 / 1 is right.
- [ ] When it reports back: **Working** while Claude reads the result, then 0 / 1

Then give it a longer task and press Esc partway through.
- [ ] Within a few seconds: **Your move**. Claude Code sends no Stop hook on an interrupt, so **Status from** may say transcript.

### 4. CLI session
In a terminal in any repo, run `claude`, send a prompt and let it finish.
- [ ] **App** CLI, Working, then Your move
- [ ] After about a minute idle: **Needs you** with "Claude is waiting for your input" (the CLI's idle reminder)

### 5. VS Code session
In the Claude Code extension, send one short prompt.
- [ ] **App** VS Code, Working, then Your move
- [ ] **Session** shows the AI title once VS Code writes one

### 6. Close a session
Exit the CLI session from check 4 with `/exit`. Close or archive one desktop session.
- [ ] The CLI row disappears and shows as **Ended** when you tick Ended
- [ ] Note what the desktop session does: the app may not send SessionEnd when you close a session

### 7. Restart the core mid-way
1. Start a turn in any session that takes a while.
2. Stop the core (Ctrl+C in its terminal) while the turn runs. It prints "Agent Foundry core stopped." and nothing else.
   Hook events now go to `~/.agent-foundry/spool.jsonl`.
3. Let the turn finish, and send one more prompt somewhere.
4. Start the core again with `pnpm dev:core`.
- [ ] The startup line counts the spooled events it ingested
- [ ] Both sessions show their current state (Your move, or Working if still busy), with no duplicate rows
- [ ] Restarting once more without doing anything records nothing new: the startup line says 0 spooled and 0 transcript events

## Results
Write one line per miss: the check, the session name, what the table showed, what you expected, and the time.

First run, 20 Nov 2026, 00:36–01:03. Checks 1, 2, 4, 5 and 6 matched. Three misses, all fixed; checks 3 and 7 need a re-run.
- **3, subagent** (WebSocket server setup, 00:45 and 00:48): **Agents** showed 1 / 1 for under a second. The Agent call now
  returns at once (`async_launched`) and the subagent runs in the background; the projector took the return for the end.
  Fixed: such agents count as background and run until SubagentStop, or until a Stop no longer lists them in
  `background_tasks`. A subagent stopped early (`stoppedByUser` in its meta) counts as done.
- **3, interrupt** (same session, 00:50): Esc 2.6 s after the prompt left it on **Working**. Transcript turns had to be 5 s
  newer than the last hook, and an internal agent's SubagentStop at 00:50:23 counted as one. Fixed: an interrupt only has to
  be newer than the last hook, since none ever follows it, and only hooks for the session's own turn count.
- **7, Ctrl+C** (00:57): tsx printed "Previous process hasn't exited yet. Force killing..." and pnpm "Exit status 130".
  The core never handled the signal, and pnpm passes Ctrl+C on to tsx a second time. Fixed: the core stops cleanly
  (closes the log, exits 0), and `dev` uses Node's own `--watch`, which doesn't mind the second signal.
