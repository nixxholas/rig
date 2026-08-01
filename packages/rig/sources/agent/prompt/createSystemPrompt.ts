import { AGENTS_MD_SPEC } from "./agentsMdSpec.js";
import { createCodexCollaborationInstructions } from "./codexInstructions.js";
import {
    createAvailableModelsInstructions,
    createParentDelegationInstructions,
    createPermissionInstructions,
    RIG_AGENT_TOOL_INSTRUCTIONS,
} from "./instructions.js";
import type { AgentContext } from "../context/AgentContext.js";
import { loadSkillInstructions } from "../skills/loadSkillInstructions.js";
import type { AnyDefinedTool, Message } from "../types.js";
import type { Model, PreambleMessage, Provider } from "@slopus/rig-execution";
import { createSecretInstructions } from "../../secrets/index.js";
import type { DurableSkillDefinition } from "../../external-skills/types.js";

export interface CreateSystemPromptOptions {
    appendSystemPrompt?: string;
    /** Exact integration-owned prompt. When present, Rig's assembled prompt is replaced. */
    systemPrompt?: string;
    provider: Provider;
    model: Model;
    instructions?: string;
    messages: readonly Message[];
    context: AgentContext;
    tools?: readonly AnyDefinedTool[];
    durableSkills?: readonly DurableSkillDefinition[];
    effort?: string;
}

export async function createSystemPrompt(
    options: CreateSystemPromptOptions,
): Promise<string | undefined> {
    const parts: string[] = [];

    if (options.instructions !== undefined && options.instructions.length > 0) {
        parts.push(options.instructions);
    }

    // System messages are positional notices delivered in the conversation, so they are
    // deliberately absent here. Folding one into the prompt would move it away from the turn it
    // belongs to and rewrite the cached prefix on every notice.

    // Every provider receives the project instructions the same way, so every provider is told
    // how to read them. Stating it unconditionally keeps the cached prefix stable when a project
    // gains or loses an AGENTS.md file mid-session.
    parts.push(AGENTS_MD_SPEC);

    const skillInstructions = await loadSkillInstructions(
        options.context.fs,
        options.durableSkills ?? [],
    );
    if (skillInstructions !== undefined) {
        parts.push(skillInstructions);
    }

    if (options.context.subagents?.canSpawn === true) {
        const availableModelsInstructions = createAvailableModelsInstructions(
            options.context.subagents.availableModels ?? [],
            options.context.subagents.disabledProviders ?? [],
        );
        if (availableModelsInstructions !== undefined) {
            parts.push(availableModelsInstructions);
        }
    }

    if (
        options.provider.type === "codex" &&
        (options.model.id === "openai/gpt-5.6-sol" ||
            options.model.id === "openai/gpt-5.6-terra") &&
        options.context.subagents !== undefined &&
        options.tools?.some((tool) => tool.namespace?.name === "collaboration") === true
    ) {
        parts.push(
            createCodexCollaborationInstructions({
                canSpawn: options.context.subagents.canSpawn,
                depth: options.context.subagents.depth,
                maxActive: options.context.subagents.maxActive ?? 4,
            }),
        );
    }

    if (options.context.subagents?.canSpawn === true && options.context.subagents.depth === 0) {
        parts.push(createParentDelegationInstructions());
    }

    if (options.tools?.some((tool) => tool.namespace?.name === "rig") === true) {
        parts.push(RIG_AGENT_TOOL_INSTRUCTIONS);
    }

    if (options.context.permissions !== undefined) {
        parts.push(
            createPermissionInstructions(options.context.permissions.mode, options.tools ?? []),
        );
    }

    if (options.context.secrets !== undefined) {
        const secretInstructions = createSecretInstructions(options.context.secrets);
        if (secretInstructions !== undefined) parts.push(secretInstructions);
    }

    if (options.appendSystemPrompt !== undefined && options.appendSystemPrompt.length > 0) {
        parts.push(options.appendSystemPrompt);
    }

    return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export interface ProviderPrompt {
    systemPrompt?: string;
    systemPromptOverride?: string;
    preamble?: readonly PreambleMessage[];
}

export async function createProviderPrompt(
    options: CreateSystemPromptOptions,
): Promise<ProviderPrompt> {
    const systemPrompt = await createSystemPrompt(options);
    return {
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
        ...(options.systemPrompt === undefined
            ? {}
            : { systemPromptOverride: options.systemPrompt }),
    };
}
