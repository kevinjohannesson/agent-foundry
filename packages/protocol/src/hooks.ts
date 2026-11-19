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
  "PostToolUseFailure", // replaces PostToolUse when the call fails
  "PermissionRequest", // a tool call needs your decision; no tool_use_id
  "PermissionDenied", // auto mode denied a tool call
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure", // replaces Stop when the turn ends on an API error
  "PreCompact",
  "PostCompact",
  "CwdChanged",
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
    tool_use_id: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
    /** Set on tool events inside a subagent, and on SubagentStart/SubagentStop. Empty for Claude Code's internal agents. */
    agent_id: z.string().optional(),
    agent_type: z.string().optional(),
    message: z.string().optional(),
    notification_type: z.string().optional(),
    /** PostToolUseFailure: the failure; StopFailure: the error type, e.g. "rate_limit". */
    error: z.unknown().optional(),
    is_interrupt: z.boolean().optional(),
    source: z.string().optional(),
    reason: z.string().optional(),
    stop_hook_active: z.boolean().optional(),
    old_cwd: z.string().optional(),
    new_cwd: z.string().optional(),
  })
  .passthrough();
export type HookPayload = z.infer<typeof HookPayload>;

/** Tools that start a subagent. Claude Code has used both names. */
export const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);
