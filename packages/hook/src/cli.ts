/**
 * pnpm hooks:install   adds the forwarder to ~/.claude/settings.json (a backup is written first)
 * pnpm hooks:uninstall removes only the entries this tool added
 * Add --spool-only to install so events go straight to ~/.agent-foundry/spool.jsonl (used by the M0 spike).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withFoundryHooks, withoutFoundryHooks } from "./settings";

const settingsPath = process.env.CLAUDE_SETTINGS || join(homedir(), ".claude", "settings.json");
const forwarder = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/foundry-hook.mjs");
const [cmd, ...flags] = process.argv.slice(2);

function read(): Record<string, unknown> {
  if (!existsSync(settingsPath)) return {};
  return JSON.parse(readFileSync(settingsPath, "utf8"));
}
function write(obj: unknown) {
  mkdirSync(dirname(settingsPath), { recursive: true });
  if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.foundry-backup-${Date.now()}`);
  writeFileSync(settingsPath, JSON.stringify(obj, null, 2) + "\n");
}

if (cmd === "install") {
  const env = flags.includes("--spool-only") ? "FOUNDRY_SPOOL_ONLY=1 " : "";
  write(withFoundryHooks(read(), `${env}node "${forwarder}"`));
  console.log(`Agent Foundry hooks added to ${settingsPath}${env ? " (spool only)" : ""}. A backup sits next to it.`);
  console.log("Running desktop-app sessions pick this up right away; restart a CLI or VS Code session if its events don't show up.");
} else if (cmd === "uninstall") {
  write(withoutFoundryHooks(read()));
  console.log(`Agent Foundry hooks removed from ${settingsPath}. A backup sits next to it.`);
} else {
  console.log("Usage: tsx packages/hook/src/cli.ts install [--spool-only] | uninstall");
  process.exit(1);
}
