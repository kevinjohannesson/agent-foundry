import { describe, expect, it } from "vitest";
import { withFoundryHooks, withoutFoundryHooks } from "./settings";

const cmd = 'node "/x/packages/hook/bin/foundry-hook.mjs"';

describe("hook settings", () => {
  it("adds one entry per event and keeps other hooks", () => {
    const before = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command" as const, command: "say done" }] }] } };
    const after = withFoundryHooks(before, cmd);
    expect(after.model).toBe("opus");
    expect(after.hooks!.Stop).toHaveLength(2);
    expect(after.hooks!.PreToolUse![0]!.matcher).toBe("*");
    expect(after.hooks!.SessionStart![0]!.matcher).toBeUndefined();
  });
  it("matches every tool on tool events and leaves the matcher off elsewhere", () => {
    const hooks = withFoundryHooks({}, cmd).hooks!;
    for (const ev of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"]) expect(hooks[ev]![0]!.matcher).toBe("*");
    for (const ev of ["SubagentStart", "StopFailure", "PostCompact", "CwdChanged", "Notification"]) expect(hooks[ev]![0]!.matcher).toBeUndefined();
    expect(Object.keys(hooks)).toHaveLength(16);
  });
  it("is idempotent", () => {
    const once = withFoundryHooks({}, cmd);
    expect(withFoundryHooks(once, cmd)).toEqual(once);
  });
  it("removes only its own entries", () => {
    const before = { hooks: { Stop: [{ hooks: [{ type: "command" as const, command: "say done" }] }] } };
    expect(withoutFoundryHooks(withFoundryHooks(before, cmd))).toEqual(before);
  });
});
