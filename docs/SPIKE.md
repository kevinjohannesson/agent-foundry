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
