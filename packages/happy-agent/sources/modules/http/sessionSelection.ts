import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    agentPermissionModeSchema,
    type AgentBaseMessageOptions,
    type AgentModel,
    type AgentPermissionMode,
} from "@slopus/happy-agent-base";
import type { EventsModule } from "@slopus/happy-agent-modules";
import type { Context } from "@steve.kite/stdlib";

import type {
    ConversationModule,
    ConversationRecord,
} from "../conversations/ConversationModule.js";

/**
 * How a session's inference is chosen, and how a change to it is recorded.
 *
 * Both the HTTP session routes and the Happy phone connection settle the very same question — what a
 * turn runs on, and how hard it thinks — and record a change the very same way. Keeping it here is
 * what keeps them from drifting: a message from a client and a message from the phone leave a
 * session in the same state, described by the same events.
 */

const sessionConfigurationFieldSchema = Type.Union([
    Type.Literal("model"),
    Type.Literal("effort"),
    Type.Literal("serviceTier"),
]);

export const sessionSelectionSchema = Type.Object(
    {
        effort: Type.String({ minLength: 1, maxLength: 64 }),
        modelId: Type.String({ minLength: 1, maxLength: 256 }),
        permissionMode: agentPermissionModeSchema,
        providerId: Type.String({ minLength: 1, maxLength: 256 }),
        serviceTier: Type.Union([Type.Literal("fast"), Type.Null()]),
    },
    { additionalProperties: false },
);

export const sessionConfigurationChangedPayloadSchema = Type.Object(
    {
        changed: Type.Array(sessionConfigurationFieldSchema, { minItems: 1, maxItems: 3 }),
        effort: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        modelId: Type.String({ minLength: 1, maxLength: 256 }),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        providerId: Type.String({ minLength: 1, maxLength: 256 }),
        serviceTier: Type.Union([Type.Literal("fast"), Type.Null()]),
    },
    { additionalProperties: false },
);

export const permissionModeChangedPayloadSchema = Type.Object(
    {
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        permissionMode: agentPermissionModeSchema,
    },
    { additionalProperties: false },
);

export type SessionSelection = Static<typeof sessionSelectionSchema>;
type SessionConfigurationChangedPayload = Static<typeof sessionConfigurationChangedPayloadSchema>;
type PermissionModeChangedPayload = Static<typeof permissionModeChangedPayloadSchema>;

/** What conversation writes a selection change has to reach: the record, and the journal. */
export interface SessionSelectionRecorders {
    readonly conversations: ConversationModule;
    readonly events: EventsModule;
}

/**
 * What a session that was never given a selection reports.
 *
 * Every session created through a client names its own selection, and every message names one
 * again. The root chat is the exception: the agent creates it while starting, so it runs on the
 * first entry of the catalog exactly as Agent Base itself would.
 */
export function catalogSelection(
    models: readonly AgentModel[],
    defaultPermissionMode: AgentPermissionMode,
): SessionSelection {
    const first = models[0];
    return {
        effort: first?.defaultEffort ?? "medium",
        modelId: first?.id ?? "",
        permissionMode: defaultPermissionMode,
        providerId: first?.providerId ?? "",
        serviceTier: null,
    };
}

export function sessionSelection(
    session: ConversationRecord,
    fallback: SessionSelection,
): SessionSelection {
    const selection = {
        effort: session.effort ?? fallback.effort,
        modelId: session.modelId ?? fallback.modelId,
        permissionMode: Value.Check(agentPermissionModeSchema, session.permissionMode)
            ? session.permissionMode
            : fallback.permissionMode,
        providerId: session.providerId ?? fallback.providerId,
        serviceTier: session.serviceTier ?? null,
    };
    if (!Value.Check(sessionSelectionSchema, selection)) {
        throw new Error("The session has an invalid model selection.");
    }
    return selection;
}

export function selectionFromMessageOptions(
    options: AgentBaseMessageOptions,
    current: SessionSelection,
): SessionSelection {
    return {
        effort: options.effort ?? current.effort,
        modelId: options.model ?? current.modelId,
        permissionMode: options.permissionMode ?? current.permissionMode,
        providerId: options.provider ?? current.providerId,
        serviceTier: options.serviceTier === "priority" ? "fast" : null,
    };
}

/**
 * Remembers what a message ran on, so the next one starts where the last left off.
 *
 * A selection that changed nothing writes nothing; a selection that changed something updates the
 * record and journals the change in the same transaction, so the conversation a person reads and
 * the event stream a client follows never disagree about what the session is set to.
 */
export async function persistSessionSelection(
    ctx: Context,
    recorders: SessionSelectionRecorders,
    session: ConversationRecord,
    next: SessionSelection,
    fallback: SessionSelection,
    mutationId?: string,
): Promise<ConversationRecord> {
    if (!Value.Check(sessionSelectionSchema, next)) {
        throw new Error("The requested session selection is invalid.");
    }
    const current = sessionSelection(session, fallback);
    const changed: SessionConfigurationChangedPayload["changed"][number][] = [];
    if (current.modelId !== next.modelId || current.providerId !== next.providerId) {
        changed.push("model");
    }
    if (current.effort !== next.effort) changed.push("effort");
    if (current.serviceTier !== next.serviceTier) changed.push("serviceTier");
    const permissionChanged = current.permissionMode !== next.permissionMode;
    if (changed.length === 0 && !permissionChanged) return session;

    return await ctx.inTx(async (txCtx) => {
        const updated = await recorders.conversations.update(txCtx, session.id, {
            effort: next.effort,
            modelId: next.modelId,
            permissionMode: next.permissionMode,
            providerId: next.providerId,
            serviceTier: next.serviceTier,
        });
        if (changed.length > 0) {
            const payload: SessionConfigurationChangedPayload = {
                changed,
                effort: next.effort,
                modelId: next.modelId,
                ...(mutationId === undefined ? {} : { mutationId }),
                providerId: next.providerId,
                serviceTier: next.serviceTier,
            };
            await recorders.conversations.appendEvent(txCtx, session.id, {
                payload,
                type: "session_configuration_changed",
            });
            await recorders.events.record(txCtx, {
                agentId: session.agentId,
                payload,
                type: "session.configuration-changed",
            });
        }
        if (permissionChanged) {
            const payload: PermissionModeChangedPayload = {
                ...(mutationId === undefined ? {} : { mutationId }),
                permissionMode: next.permissionMode,
            };
            await recorders.conversations.appendEvent(txCtx, session.id, {
                payload,
                type: "permission_mode_changed",
            });
            await recorders.events.record(txCtx, {
                agentId: session.agentId,
                payload,
                type: "session.permission-mode-changed",
            });
        }
        return updated;
    });
}
