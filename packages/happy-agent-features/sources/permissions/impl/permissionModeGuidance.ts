import { agentPermissionModeLabel, type AgentPermissionMode } from "@slopus/happy-agent-base";

/**
 * What the model is told about the mode it is working in. A model that knows what it may touch
 * spends its turn on work that can actually happen, instead of discovering the boundary one refused
 * tool call at a time.
 */
export function permissionModeGuidance(mode: AgentPermissionMode): string {
    return `You are working in ${agentPermissionModeLabel(mode)} mode. ${rules(mode)}`;
}

/**
 * What the agent is sent when somebody changes its mode. The change travels with a message, so the
 * message may as well be the one that says what changed: the model reads it in the conversation at
 * exactly the point the new mode takes effect.
 */
export function permissionModeChangeNotice(mode: AgentPermissionMode): string {
    return `The permission mode has been changed to ${agentPermissionModeLabel(mode)}. ${rules(mode)}`;
}

/** The one paragraph that says what this mode actually permits. */
function rules(mode: AgentPermissionMode): string {
    switch (mode) {
        case "read_only":
            return (
                "You may inspect anything the tools reach, and change nothing: no files, no " +
                "workspace state, and nothing outside this session. Tools that act beyond the " +
                "sandbox are unavailable and asking for them again will not change that. When a " +
                "task needs a change, say precisely what you would do and let the person decide."
            );
        case "workspace_write":
            return (
                "You may change files inside the workspace. Writes outside it and network access " +
                "from the shell stay blocked, tools that act beyond the sandbox are unavailable, " +
                "and asking to escalate has no effect in this mode. When the work genuinely needs " +
                "more, stop and explain what is missing."
            );
        case "auto":
            return (
                "Routine work runs inside the workspace sandbox. An action that would cross that " +
                "boundary is reviewed automatically before it runs; the person is never asked, " +
                "and the answer is final. A refused action is not an obstacle to route around: " +
                "continue with a materially safer alternative, or stop and explain what you need " +
                "and why. Repeating a refused action in another form will fail again."
            );
        case "full_access":
            return (
                "No filesystem, shell, or network restriction of Rig's own applies, so nothing " +
                "will stop a destructive or outward-facing action on your behalf. Take the care " +
                "the absence of a boundary calls for: confirm anything hard to reverse before " +
                "doing it."
            );
    }
}
