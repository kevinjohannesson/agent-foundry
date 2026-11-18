import { z } from "zod";

/**
 * What Claude Code sends a hook command on stdin.
 * Only the common fields are required; everything event-specific is optional
 * and unknown fields are kept, so new Claude Code versions don't break ingest.
 */
export const HookEventName = z.enum([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionEnd",
]);
export type HookEventName = z.infer<typeof HookEventName>;

export const HookPayload = z
  .object({
    session_id: z.string(),
    hook_event_name: z.string(),
    transcript_path: z.string().optional(),
    cwd: z.string().optional(),
    permission_mode: z.string().optional(),
    prompt: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
    message: z.string().optional(),
    source: z.string().optional(),
    reason: z.string().optional(),
    stop_hook_active: z.boolean().optional(),
  })
  .passthrough();
export type HookPayload = z.infer<typeof HookPayload>;

/** Tools that start a subagent. Claude Code has used both names. */
export const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);
