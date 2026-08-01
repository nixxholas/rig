import type { AgentContext } from "../context/AgentContext.js";
import type { PermissionMode } from "../../permissions/index.js";
import { escapeXml } from "../skills/escapeXml.js";

export function createCodexCollaborationInstructions(options: {
    canSpawn: boolean;
    depth: number;
    maxActive: number;
}): string {
    const usageHint =
        options.depth === 0
            ? options.canSpawn
                ? `You are \`/root\`, the primary agent in a team of agents collaborating to fulfill the user's goals.

At the start of your turn, you are the active agent.
You can spawn sub-agents to handle subtasks.
All agents in the team, including the agents that you can assign tasks to, are equally intelligent and capable, and have access to the same set of tools.

You can use \`spawn_agent\` to create a new agent, \`followup_task\` to give an existing agent a new task and trigger a turn, and \`send_message\` to pass a message to a running agent without triggering a turn.
You can decide how much context you want to propagate to your sub-agents with the \`fork_turns\` parameter.

You will receive messages in the analysis channel in the form:
\`\`\`
Message Type: MESSAGE | FINAL_ANSWER
Task name: <recipient>
Sender: <author>
Payload:
<payload text>
\`\`\`
They may be addressed as to=/root`
                : `You are \`/root\`, the primary agent in a team of agents collaborating to fulfill the user's goals.

You cannot spawn additional sub-agents at this depth. Use the available collaboration tools only to manage agents that already exist.

You will receive messages in the analysis channel in the form:
\`\`\`
Message Type: MESSAGE | FINAL_ANSWER
Task name: <recipient>
Sender: <author>
Payload:
<payload text>
\`\`\`
They may be addressed as to=/root`
            : options.canSpawn
              ? `You are a child agent in a team of agents collaborating to complete a task for your parent agent.

You have collaboration tools for communicating with the team. Although \`spawn_agent\` is available at this depth, do not use it unless your parent explicitly allowed nested delegation in your assigned task.

You can use \`spawn_agent\` to create a new agent, \`followup_task\` to give an existing agent a new task and trigger a turn, and \`send_message\` to pass a message to a running agent.

When you provide a response in the final channel, that content is immediately delivered back to your parent agent.

You will receive messages in the analysis channel in the form:
\`\`\`
Message Type: NEW_TASK | MESSAGE | FINAL_ANSWER
Task name: <recipient>
Sender: <author>
Payload:
<payload text>
\`\`\`
You may also see them addressed as to=/root/..., which indicates your identity is /root/...`
              : `You are a child agent in a team of agents collaborating to complete a task for your parent agent.

You cannot spawn additional sub-agents at this depth. Use the available collaboration tools only to manage agents that already exist.

When you provide a response in the final channel, that content is immediately delivered back to your parent agent.

You will receive messages in the analysis channel in the form:
\`\`\`
Message Type: NEW_TASK | MESSAGE | FINAL_ANSWER
Task name: <recipient>
Sender: <author>
Payload:
<payload text>
\`\`\`
You may also see them addressed as to=/root/..., which indicates your identity is /root/...`;
    const directTools = options.canSpawn
        ? "`spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, and `list_agents`"
        : "`send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, and `list_agents`";
    const directToolExample = options.canSpawn
        ? "`to=functions.collaboration.spawn_agent`"
        : "`to=functions.collaboration.send_message`";
    const sharedHint = `Note that collaboration tools cannot be called from inside \`functions.exec\`. Call ${directTools} only as direct tool calls using the recipient shown in their tool definitions, such as ${directToolExample}, since they are intentionally absent from the \`functions.exec\` \`tools.*\` namespace. Available tools in \`functions.exec\` are explicitly described with a \`tools\` namespace in the developer message.

All agents share the same directory. In detail:
- All agents have access to the same container and filesystem as you.
- All agents use the same current working directory.
- As a result, edits made by one agent are immediately visible to all other agents.

There are ${options.maxActive} available concurrency slots, meaning that up to ${options.maxActive} agents can be active at once, including you.

A background agent notifies you when it finishes, even while you are idle, so never poll one. When there is nothing to do but wait, call \`wait_agent\` once without \`timeout_ms\`, which waits an hour, or simply end your turn. Every wait that times out costs another full model turn over your whole context and tells you nothing.`;
    const modelOverrideHint =
        "Every `spawn_agent` call states the child's `model` and `reasoning_effort`; nothing is inherited. Choose both for the task at hand: the model's default effort, or a lower level, suits research, review, and other bounded work, and `xhigh`, `max`, or `ultra` is only for work the user asked to run at that effort.";
    return [usageHint, sharedHint, ...(options.canSpawn ? [modelOverrideHint] : [])].join("\n\n");
}

export function createCodexPermissionInstructions(mode: PermissionMode): string {
    const sandbox =
        mode === "full_access"
            ? "Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `danger-full-access`: No filesystem sandboxing - all commands are permitted. Network access is enabled."
            : mode === "read_only"
              ? "Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `read-only`: The sandbox only permits reading files. Network access is restricted."
              : "Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `workspace-write`: The sandbox permits reading files, and editing files in `cwd` and `writable_roots`. Editing files in other directories requires approval. Network access is restricted.";
    const approval =
        mode === "auto"
            ? "`approvals_reviewer` is `auto_review`: Sandbox escalations with require_escalated will be reviewed for compliance with the policy. If a rejection happens, you should proceed only with a materially safer alternative, or inform the user of the risk and send a final message to ask for approval."
            : "Approval policy is currently never. Do not provide the `sandbox_permissions` for any reason, commands will be rejected.";
    return `<permissions instructions>\n${sandbox}\n${approval}\n</permissions instructions>`;
}

export function createCodexBedrockEnvironmentContext(context: AgentContext): string {
    const currentDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
    const permissionMode = context.permissions?.mode ?? "full_access";
    const cwd = escapeXml(context.fs.cwd);
    const shell = escapeXml(process.env.SHELL ?? "zsh");
    const date = escapeXml(currentDate);
    const timezone = escapeXml(Intl.DateTimeFormat().resolvedOptions().timeZone);
    const fileSystem =
        permissionMode === "full_access"
            ? '<permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile>'
            : permissionMode === "read_only"
              ? '<permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry></file_system></permission_profile>'
              : `<permission_profile type="managed"><file_system type="restricted"><entry access="write"><path>${cwd}</path></entry></file_system></permission_profile>`;
    return [
        "<environment_context>",
        `  <cwd>${cwd}</cwd>`,
        `  <shell>${shell}</shell>`,
        `  <current_date>${date}</current_date>`,
        `  <timezone>${timezone}</timezone>`,
        `  <filesystem><workspace_roots><root>${cwd}</root></workspace_roots>${fileSystem}</filesystem>`,
        "</environment_context>",
    ].join("\n");
}
