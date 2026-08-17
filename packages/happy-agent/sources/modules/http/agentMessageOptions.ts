import type {
    AgentBaseMessageOptions,
    AgentModel,
    AgentPermissionMode,
} from "@slopus/happy-agent-base";
import { USER_MESSAGE_ORIGIN_METADATA } from "@slopus/happy-agent-modules";

import { AgentHttpError } from "./errors.js";

/**
 * Everything a caller names for one message.
 *
 * The agent has no opinion about what a turn should run on. Every request says which account, which
 * model, how hard to think and which service tier, and the agent refuses anything its catalog
 * cannot serve rather than quietly choosing something else.
 */
export interface RequestedAgentSelection {
    readonly effort: string;
    readonly model: string;
    readonly provider: string;
    /** `fast` and `priority` both mean the provider's priority tier; `null` means its standard one. */
    readonly serviceTier: "fast" | "priority" | null;
    readonly permissionMode?: AgentPermissionMode;
}

/** Refuses a selection the catalog cannot serve, in the words a caller needs to correct it. */
export function checkAgentSelection(
    models: readonly AgentModel[],
    requested: RequestedAgentSelection,
): AgentModel {
    const selected = models.find(
        (candidate) =>
            candidate.id === requested.model && candidate.providerId === requested.provider,
    );
    if (selected === undefined) {
        const servedBy = models
            .filter((candidate) => candidate.id === requested.model)
            .map((candidate) => candidate.providerId);
        throw new AgentHttpError(
            400,
            servedBy.length === 0
                ? `Model "${requested.model}" is not available in this agent's model catalog.`
                : `Model "${requested.model}" is not served by provider "${requested.provider}".`,
        );
    }
    if (!selected.effortLevels.includes(requested.effort as AgentModel["defaultEffort"])) {
        throw new AgentHttpError(
            400,
            `Effort "${requested.effort}" is not supported by model "${selected.id}" for provider "${selected.providerId}".`,
        );
    }
    if (requested.serviceTier !== null && selected.serviceTiers?.includes("priority") !== true) {
        throw new AgentHttpError(
            400,
            `A priority service tier is not supported by model "${selected.id}" for provider "${selected.providerId}".`,
        );
    }
    return selected;
}

/** One HTTP message's inference settings, exactly as the caller named them. */
export function agentMessageOptions(
    models: readonly AgentModel[],
    requested: RequestedAgentSelection,
    extras: { readonly await?: boolean; readonly id?: string } = {},
): AgentBaseMessageOptions & { readonly await?: boolean } {
    checkAgentSelection(models, requested);
    return {
        // Every message that reaches this helper is an end-user submission through the daemon's HTTP
        // send/steer routes; agent-internal sends (goal continuations, collaboration) never pass
        // through here. Stamping the human-origin marker is what lets the automatic permission
        // reviewer trust these messages as authorization while treating everything unstamped as
        // untrusted context.
        metadata: { ...USER_MESSAGE_ORIGIN_METADATA },
        ...(extras.await === undefined ? {} : { await: extras.await }),
        ...(extras.id === undefined ? {} : { id: extras.id }),
        effort: requested.effort as never,
        model: requested.model,
        provider: requested.provider,
        ...(requested.permissionMode === undefined
            ? {}
            : { permissionMode: requested.permissionMode }),
        ...(requested.serviceTier === null ? {} : { serviceTier: "priority" as never }),
    };
}
