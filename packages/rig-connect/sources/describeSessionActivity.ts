import type {
    SessionActivity,
    SessionActivityKind,
    SessionActivityPermissionReview,
    SessionActivityToolCall,
} from "./protocol.js";

/**
 * The kind of work a running tool represents, in terms a person recognises.
 *
 * A status line does not care that a shell command arrived as `Bash` from Claude,
 * `exec_command` from Codex, and `run_terminal_command` from Grok: the session is
 * waiting for a shell either way. The category is what a UI groups and phrases
 * on, and `unknown` keeps a tool this library has not seen from being described
 * as something it is not.
 */
export type ToolCategory =
    | "background_process"
    | "file_edit"
    | "file_read"
    | "mcp"
    | "media"
    | "planning"
    | "question"
    | "schedule"
    | "search"
    | "shell"
    | "subagent"
    | "unknown"
    | "web"
    | "workflow";

/**
 * What the session is doing right now, ready to display.
 *
 * `label` is the one string a status line needs. The rest is there so an
 * interface can decide for itself: show an icon per category, list the calls it
 * is waiting on, or fall back to the raw kind.
 */
export interface SessionActivityDescription {
    readonly kind: SessionActivityKind;
    /** A human-readable sentence, such as `Waiting for bash`. */
    readonly label: string;
    /**
     * The tool calls the session is currently blocked on, in start order. Empty
     * whenever the session is not executing tools.
     */
    readonly awaitingTools: readonly SessionActivityToolCall[];
    /** Tool calls whose requested action is currently being reviewed in Auto. */
    readonly reviewingTools: readonly SessionActivityPermissionReview[];
    /**
     * The shared category of the tools being reviewed or awaited, or `unknown`
     * when they disagree. Absent when neither phase is active.
     */
    readonly toolCategory?: ToolCategory;
}

const TOOL_CATEGORIES = new Map<string, ToolCategory>([
    ["agent", "subagent"],
    ["agent_info", "subagent"],
    ["agent_me", "subagent"],
    ["agent_send", "subagent"],
    ["apply_patch", "file_edit"],
    ["archive_workspace", "planning"],
    ["askuserquestion", "question"],
    ["ask_user_question", "question"],
    ["bash", "shell"],
    ["codex_imagegen", "media"],
    ["create_goal", "planning"],
    ["create_workspace", "planning"],
    ["delegate_to_workspace", "subagent"],
    ["edit", "file_edit"],
    ["exec", "shell"],
    ["exec_command", "shell"],
    ["followup_subagent", "subagent"],
    ["followup_task", "subagent"],
    ["gemini_analyze_media", "media"],
    ["gemini_generate_image", "media"],
    ["gemini_generate_music", "media"],
    ["gemini_search", "web"],
    ["get_command_or_subagent_output", "background_process"],
    ["get_goal", "planning"],
    ["glob", "search"],
    ["grep", "search"],
    ["image_edit", "media"],
    ["image_gen", "media"],
    ["image_to_video", "media"],
    ["imagegen", "media"],
    ["interrupt_agent", "subagent"],
    ["kill_command_or_subagent", "background_process"],
    ["list_agents", "subagent"],
    ["list_dir", "search"],
    ["list_mcp_resource_templates", "mcp"],
    ["list_mcp_resources", "mcp"],
    ["list_projects", "planning"],
    ["list_workspace_sessions", "planning"],
    ["list_workspaces", "planning"],
    ["monitor", "background_process"],
    ["multiedit", "file_edit"],
    ["read", "file_read"],
    ["read_agent_history", "subagent"],
    ["read_file", "file_read"],
    ["read_mcp_resource", "mcp"],
    ["reference_to_video", "media"],
    ["run_terminal_command", "shell"],
    ["schedule_message", "schedule"],
    ["scheduler_create", "schedule"],
    ["scheduler_delete", "schedule"],
    ["scheduler_list", "schedule"],
    ["search_replace", "file_edit"],
    ["search_tool", "search"],
    ["send_command_input", "shell"],
    ["send_message", "subagent"],
    ["sendmessage", "subagent"],
    ["shell", "shell"],
    ["spawn_agent", "subagent"],
    ["spawn_subagent", "subagent"],
    ["spawn_workspace_agent", "subagent"],
    ["stop_workflow", "workflow"],
    ["taskcreate", "planning"],
    ["taskget", "planning"],
    ["taskinput", "shell"],
    ["tasklist", "planning"],
    ["taskoutput", "background_process"],
    ["taskstop", "background_process"],
    ["taskupdate", "planning"],
    ["todo_write", "planning"],
    ["update_goal", "planning"],
    ["update_plan", "planning"],
    ["use_tool", "mcp"],
    ["view_image", "file_read"],
    ["wait", "schedule"],
    ["wait_agent", "subagent"],
    ["wait_commands_or_subagents", "background_process"],
    ["wait_until", "schedule"],
    ["waitforworkflow", "workflow"],
    ["web_fetch", "web"],
    ["web_search", "web"],
    ["webfetch", "web"],
    ["websearch", "web"],
    ["workflow", "workflow"],
    ["workflow_status", "workflow"],
    ["write", "file_edit"],
    ["write_stdin", "shell"],
]);

const CATEGORY_LABELS: Record<ToolCategory, string> = {
    background_process: "Waiting for a background process",
    file_edit: "Editing files",
    file_read: "Reading files",
    mcp: "Waiting for an MCP server",
    media: "Generating media",
    planning: "Organizing the work",
    question: "Waiting for an answer",
    schedule: "Waiting",
    search: "Searching the workspace",
    shell: "Waiting for bash",
    subagent: "Waiting for subagents",
    unknown: "Running tools",
    web: "Searching the web",
    workflow: "Waiting for a workflow",
};

/**
 * Sorts a tool name into the kind of work it represents.
 *
 * Names are compared case-insensitively because the same capability is spelled
 * `Bash`, `bash`, and `exec_command` depending on which provider issued it, and
 * a session waiting on a shell is waiting on a shell in all three cases.
 */
export function classifyToolName(toolName: string): ToolCategory {
    if (toolName.startsWith("mcp__")) return "mcp";
    return TOOL_CATEGORIES.get(toolName.toLowerCase()) ?? "unknown";
}

/**
 * Turns the live activity into the sentence a status line shows.
 *
 * Precedence follows what actually blocks the session rather than the order
 * things happened: a retry, a compaction, or a question outranks the tools that
 * were running underneath it. When tools are what the session is waiting on, the
 * phrasing comes from what they have in common — one kind of work names itself,
 * a mixture only says how many there are.
 */
export function describeSessionActivity(activity: SessionActivity): SessionActivityDescription {
    const awaitingTools = activity.toolCalls ?? [];
    const reviewingTools = activity.reviewingToolCalls ?? [];

    if (activity.retry !== undefined) {
        return described(activity, awaitingTools, `Retrying: ${activity.retry.reason}`);
    }
    if (activity.compaction !== undefined) {
        return described(activity, awaitingTools, "Compacting the conversation");
    }
    if ((activity.pendingInputRequestIds?.length ?? 0) > 0) {
        return described(activity, awaitingTools, "Waiting for an answer");
    }
    if (activity.wait !== undefined) {
        return described(activity, awaitingTools, activity.label);
    }
    if (reviewingTools.length > 0) {
        const category = sharedCategory(reviewingTools);
        return described(
            activity,
            awaitingTools,
            reviewingTools.length === 1
                ? `Reviewing ${reviewingTools[0]!.toolName}`
                : `Reviewing ${String(reviewingTools.length)} tools`,
            category,
        );
    }
    if (awaitingTools.length > 0) {
        const category = sharedCategory(awaitingTools);
        return described(activity, awaitingTools, toolLabel(awaitingTools, category), category);
    }

    switch (activity.kind) {
        case "idle":
            return described(activity, awaitingTools, "Idle");
        case "queued":
            return described(activity, awaitingTools, "Queued");
        case "thinking":
            return described(activity, awaitingTools, "Thinking");
        case "generating_message":
            return described(activity, awaitingTools, "Writing a reply");
        case "generating_tool_call":
            return described(activity, awaitingTools, "Preparing a tool call");
        case "stopped":
            return described(activity, awaitingTools, "Stopped");
        case "error":
            return described(activity, awaitingTools, "Failed");
        default:
            // A kind this library does not know still has the daemon's own
            // wording, which is better than inventing a phrase for it.
            return described(activity, awaitingTools, activity.label);
    }
}

function sharedCategory(
    toolCalls: readonly (SessionActivityPermissionReview | SessionActivityToolCall)[],
): ToolCategory {
    const first = classifyToolName(toolCalls[0]!.toolName);
    return toolCalls.every((call) => classifyToolName(call.toolName) === first) ? first : "unknown";
}

function toolLabel(toolCalls: readonly SessionActivityToolCall[], category: ToolCategory): string {
    if (category === "unknown") {
        if (toolCalls.length === 1) return `Running ${toolCalls[0]!.toolName}`;
        return `Running ${toolCalls.length} tools`;
    }
    return CATEGORY_LABELS[category];
}

function described(
    activity: SessionActivity,
    awaitingTools: readonly SessionActivityToolCall[],
    label: string,
    category?: ToolCategory,
): SessionActivityDescription {
    return {
        awaitingTools,
        kind: activity.kind,
        label,
        reviewingTools: activity.reviewingToolCalls ?? [],
        ...(category === undefined ? {} : { toolCategory: category }),
    };
}
