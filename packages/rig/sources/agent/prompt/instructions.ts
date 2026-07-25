import type {
    AvailableSubagentModel,
    DisabledSubagentProvider,
} from "../context/SubagentContext.js";
import type { PermissionMode } from "../../permissions/index.js";
import type { AnyDefinedTool } from "../types.js";

/** Marks the role section so a child can strip its parent's copy before appending its own. */
const SUBAGENT_INSTRUCTIONS_MARKER = "You are a subagent working on one delegated step.";

export const RIG_AGENT_TOOL_INSTRUCTIONS = `## Agent tool portability

- \`collaboration\` is Codex Cloud's encrypted v2 protocol. \`multi_agent_v1\` is the plaintext protocol used by Codex models on Amazon Bedrock.
- \`rig\` is provider-neutral. Use it when selecting or crossing models, providers, or regions, when native collaboration is unavailable, and when setting effort.
- If a native collaboration call rejects the target, retry with the matching \`rig\` tool and provide the normal task text. Never copy or reinterpret encrypted content.`;

export function createPermissionInstructions(
    mode: PermissionMode,
    tools: readonly AnyDefinedTool[] = [],
): string {
    if (mode === "auto") {
        const toolInstructions = [
            ...new Set(
                tools.flatMap((tool) =>
                    tool.autoPermissionInstructions === undefined
                        ? []
                        : [tool.autoPermissionInstructions],
                ),
            ),
        ];
        return [
            "You are in Auto mode. Routine reads and workspace edits run automatically. Permission-sensitive actions are reviewed automatically; low-risk actions proceed, while potentially unsafe actions require one-time user approval. Every shell tool uses the same workspace sandbox by default. Request reviewed full-access execution only when that sandbox blocks necessary work, and give a clear reason. Do not work around a denied permission or retry the same action unchanged.",
            ...toolInstructions,
        ].join("\n\n");
    }
    if (mode === "read_only") {
        return "You are in Read only mode. You may inspect files and run non-mutating shell commands. File tools cannot make changes; shell commands may only write temporary files, and shell network access is blocked.";
    }
    if (mode === "workspace_write") {
        return "You are in Workspace write mode. You may modify files inside the working directory. Shell writes outside it and shell network access are blocked.";
    }
    return "You are in Full access mode. Filesystem, shell, and network access are unrestricted.";
}

export function createAvailableModelsInstructions(
    models: readonly AvailableSubagentModel[],
    disabledProviders: readonly DisabledSubagentProvider[] = [],
): string | undefined {
    if (models.length === 0 && disabledProviders.length === 0) return undefined;

    const sections: string[] = [];
    if (models.length > 0) {
        sections.push(
            [
                "# Available models",
                "You can run subagents with any of these models by passing the provider and model ID exactly as shown. The effort value must be one of that model's listed levels:",
                ...models.map((model) => {
                    const efforts = model.effortLevels
                        .map((effort) =>
                            effort === model.defaultEffort ? `${effort} (default)` : effort,
                        )
                        .join(", ");
                    return `- ${model.providerId}: ${model.name} (\`${model.id}\`) — effort levels: ${efforts}`;
                }),
                "",
                "A request that gives you only a bare model or family name—such as Codex, GPT, Opus, or Sonnet—usually means they want you to run that model somehow. When the request can be handled by a subagent, spawn a subagent with the closest available model and provider. This is usually safe to do without asking for confirmation.",
            ].join("\n"),
        );
    }
    if (disabledProviders.length > 0) {
        sections.push(
            [
                "# Disabled providers",
                "These providers cannot be used in this daemon session. Do not try to use or suggest models from them:",
                ...disabledProviders.map((provider) => {
                    const explanation =
                        provider.reason === "not_enabled"
                            ? "disabled in configuration"
                            : provider.reason === "not_authenticated"
                              ? "no local authentication was found"
                              : "no models are available after applying configuration and regional availability";
                    return `- ${provider.id}: ${explanation}`;
                }),
            ].join("\n"),
        );
    }
    return sections.join("\n\n");
}

export function createSubagentInstructions(
    parentInstructions: string | undefined,
    depth: number,
    maxDepth: number,
): string {
    const previousStart = parentInstructions?.indexOf(SUBAGENT_INSTRUCTIONS_MARKER) ?? -1;
    const baseInstructions =
        previousStart >= 0
            ? parentInstructions?.slice(0, previousStart).trimEnd()
            : parentInstructions;
    return [
        baseInstructions,
        `${SUBAGENT_INSTRUCTIONS_MARKER} Complete the task independently and return a concise result to the parent agent.\n\nThe parent agent may send follow-up work after this step. Continue from your existing context when it does.`,
        depth < maxDepth
            ? `Collaboration tools remain available at depth ${depth} of ${maxDepth}; their availability does not authorize additional delegation.`
            : "You are at the maximum subagent depth and must complete the task directly.",
    ]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join("\n\n");
}
