/**
 * Adds or removes the Agent Foundry hook in a Claude Code settings.json.
 * Every entry we add carries the forwarder path, so removing them is exact and other hooks are untouched.
 */
/** Events whose matcher filters on tool name; `*` matches every tool. The rest get no matcher, which matches everything. */
export const EVENTS_WITH_MATCHER = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"] as const;
/**
 * Every event the forwarder records. Keep in step with HookEventName in @foundry/protocol.
 * Our hook prints nothing and decides nothing, so none of these changes how Claude Code behaves
 * (a PermissionRequest hook without a decision leaves the normal prompt in place).
 */
export const EVENTS = [
  "SessionStart", "UserPromptSubmit",
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied",
  "Notification", "SubagentStart", "SubagentStop", "Stop", "StopFailure",
  "PreCompact", "PostCompact", "CwdChanged", "SessionEnd",
] as const;
export const MARKER = "foundry-hook.mjs";

type HookCmd = { type: "command"; command: string; timeout?: number };
type HookGroup = { matcher?: string; hooks: HookCmd[] };
type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

export function withFoundryHooks(settings: Settings, command: string): Settings {
  const out: Settings = structuredClone(withoutFoundryHooks(settings));
  out.hooks ??= {};
  for (const ev of EVENTS) {
    const group: HookGroup = { hooks: [{ type: "command", command, timeout: 5 }] };
    if ((EVENTS_WITH_MATCHER as readonly string[]).includes(ev)) group.matcher = "*";
    (out.hooks[ev] ??= []).push(group);
  }
  return out;
}

export function withoutFoundryHooks(settings: Settings): Settings {
  const out: Settings = structuredClone(settings);
  if (!out.hooks) return out;
  for (const [ev, groups] of Object.entries(out.hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !h.command?.includes(MARKER)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) out.hooks[ev] = kept; else delete out.hooks[ev];
  }
  if (Object.keys(out.hooks).length === 0) delete out.hooks;
  return out;
}
