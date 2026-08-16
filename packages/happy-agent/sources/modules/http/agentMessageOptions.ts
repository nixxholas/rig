import type { AgentBaseMessageOptions } from "@slopus/happy-agent-base";
import type { AgentPermissionMode } from "@slopus/happy-agent-base";
import { USER_MESSAGE_ORIGIN_METADATA } from "@slopus/happy-agent-modules";
import {
    resolveAgentSelection,
    type AgentSelectionOverrides,
    type EffectiveAgentSelection,
} from "../../vanillaHappyAgentConfiguration.js";
import type { AgentModel } from "@slopus/happy-agent-base";
import { AgentHttpError } from "./errors.js";

export interface AgentMessageOptionOverrides {
    readonly await?: boolean;
    readonly effort?: string;
    readonly id?: string;
    readonly model?: string;
    readonly permissionMode?: AgentPermissionMode;
    readonly provider?: string;
    readonly serviceTier?: "priority" | null;
}

export function resolveAgentMessageSelection(
    defaults: EffectiveAgentSelection,
    models: readonly AgentModel[],
    overrides: AgentSelectionOverrides = {},
): EffectiveAgentSelection {
    try {
        return resolveAgentSelection(defaults, models, overrides, {
            fallbackToProviderRoute:
                overrides.provider !== undefined && overrides.model === undefined,
        });
    } catch (error) {
        throw new AgentHttpError(
            400,
            error instanceof Error ? error.message : "The requested model selection is invalid.",
        );
    }
}

/** Merge one HTTP message with the immutable daemon defaults. */
export function mergeAgentMessageOptions(
    defaults: EffectiveAgentSelection,
    models: readonly AgentModel[],
    overrides: AgentMessageOptionOverrides = {},
): AgentBaseMessageOptions & { readonly await?: boolean } {
    const selection = resolveAgentMessageSelection(defaults, models, overrides);
    return {
        // Every message that reaches this helper is an end-user submission through the daemon's HTTP
        // send/steer routes; agent-internal sends (goal continuations, collaboration) never pass
        // through here. Stamping the human-origin marker is what lets the automatic permission
        // reviewer trust these messages as authorization while treating everything unstamped as
        // untrusted context.
        metadata: { ...USER_MESSAGE_ORIGIN_METADATA },
        ...(overrides.await === undefined ? {} : { await: overrides.await }),
        ...(overrides.effort === undefined
            ? { effort: selection.effort as never }
            : { effort: overrides.effort as never }),
        ...(overrides.id === undefined ? {} : { id: overrides.id }),
        model: selection.model,
        permissionMode: overrides.permissionMode ?? defaults.permissionMode,
        ...(overrides.provider === undefined
            ? { provider: selection.provider }
            : { provider: selection.provider }),
        ...(overrides.serviceTier === undefined
            ? selection.serviceTier === undefined
                ? {}
                : { serviceTier: selection.serviceTier as never }
            : overrides.serviceTier === null
              ? {}
              : { serviceTier: overrides.serviceTier as never }),
    };
}
