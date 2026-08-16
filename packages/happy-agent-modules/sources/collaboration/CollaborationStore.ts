import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { agentConfigSchema, agentPermissionModeSchema } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import {
    collaborationAgentIdSchema,
    collaborationAgentObservationSchema,
    collaborationAgentPageQuerySchema,
    collaborationAgentPageSchema,
    collaborationAgentSchema,
    collaborationAgentSelectionSchema,
    collaborationContextModeSchema,
    collaborationForkTurnsSchema,
    collaborationMetadataSchema,
    collaborationSpawnCapacitySchema,
    type CollaborationAgentPage,
} from "./CollaborationAgent.js";
import {
    collaborationMessageIdSchema,
    collaborationMessageSchema,
    collaborationObligationIdSchema,
    collaborationObligationPageQuerySchema,
    collaborationObligationPageSchema,
    collaborationObligationSchema,
    type CollaborationObligationPage,
} from "./CollaborationMessage.js";

/**
 * Contexts are owned by Agent Base and the host. Collaboration only carries them through the
 * injected boundary; it neither inspects nor constructs a context.
 */
export const collaborationContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: true }),
);
const asyncVoidResultSchema = Type.Promise(Type.Void());

export const collaborationAuthorizationActionSchema = Type.Union([
    Type.Literal("create"),
    Type.Literal("read"),
    Type.Literal("list"),
    Type.Literal("send"),
    Type.Literal("reply"),
    Type.Literal("wait"),
    Type.Literal("interrupt"),
    Type.Literal("permission"),
]);

/**
 * Host policy for relationships that are not covered by durable ownership. Returning false is a
 * denial; the module never treats a missing policy as authorization for another agent.
 */
export const collaborationAuthorizationSchema = Type.Object(
    {
        authorize: Type.Function(
            [
                collaborationContextSchema,
                collaborationAgentIdSchema,
                collaborationAgentIdSchema,
                collaborationAuthorizationActionSchema,
            ],
            Type.Promise(Type.Boolean()),
        ),
    },
    { additionalProperties: false },
);

/** The only Agent Base message shape Collaboration sends. */
export const collaborationBrokerMessageSchema = Type.Object(
    {
        role: Type.Literal("user"),
        content: Type.Array(
            Type.Object(
                {
                    type: Type.Literal("text"),
                    text: Type.String({ minLength: 1, maxLength: 50_000 }),
                },
                { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 1 },
        ),
    },
    { additionalProperties: false },
);

export const collaborationBrokerSendOptionsSchema = Type.Object(
    {
        id: collaborationMessageIdSchema,
        metadata: Type.Optional(collaborationMetadataSchema),
    },
    { additionalProperties: false },
);

export const collaborationBrokerCreateOptionsSchema = Type.Object(
    {
        id: collaborationAgentIdSchema,
        parent: Type.Union([collaborationAgentIdSchema, Type.Null()]),
        selection: collaborationAgentSelectionSchema,
        context: collaborationContextModeSchema,
        /**
         * The creating agent's mode. The broker must make an omitted/readOnly=false child inherit
         * this mode and may only reduce it to read_only.
         */
        permissionMode: agentPermissionModeSchema,
        forkTurns: Type.Optional(collaborationForkTurnsSchema),
        readOnly: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);

export const collaborationBrokerAgentResultSchema = Type.Object(
    { id: collaborationAgentIdSchema },
    { additionalProperties: false },
);

/** Structural Agent Base/host broker capability used by Collaboration. */
export const collaborationBrokerSchema = Type.Object(
    {
        /**
         * Creation is the atomic capacity boundary. The host must re-check depth and active
         * capacity for `parent` while admitting this request; spawnCapacity is only guidance.
         */
        create: Type.Function(
            [collaborationContextSchema, agentConfigSchema, collaborationBrokerCreateOptionsSchema],
            Type.Promise(collaborationBrokerAgentResultSchema),
        ),
        config: Type.Function(
            [collaborationContextSchema, collaborationAgentIdSchema],
            Type.Promise(Type.Union([agentConfigSchema, Type.Undefined()])),
        ),
        selection: Type.Function(
            [collaborationContextSchema, collaborationAgentIdSchema],
            Type.Promise(Type.Union([collaborationAgentSelectionSchema, Type.Undefined()])),
        ),
        send: Type.Function(
            [
                collaborationContextSchema,
                collaborationAgentIdSchema,
                collaborationBrokerMessageSchema,
                collaborationBrokerSendOptionsSchema,
            ],
            asyncVoidResultSchema,
        ),
        wait: Type.Function(
            [
                collaborationContextSchema,
                collaborationAgentIdSchema,
                collaborationObligationIdSchema,
            ],
            Type.Promise(collaborationObligationSchema),
        ),
        interrupt: Type.Function(
            [collaborationContextSchema, collaborationAgentIdSchema, collaborationAgentIdSchema],
            Type.Promise(collaborationAgentObservationSchema),
        ),
        observe: Type.Function(
            [collaborationContextSchema, collaborationAgentIdSchema, collaborationAgentIdSchema],
            Type.Promise(collaborationAgentObservationSchema),
        ),
        waitForAgent: Type.Function(
            [
                collaborationContextSchema,
                collaborationAgentIdSchema,
                collaborationAgentIdSchema,
                Type.Integer({ minimum: 0, maximum: 3_600_000 }),
            ],
            Type.Promise(collaborationAgentObservationSchema),
        ),
        /**
         * `readOnly=false` means inherit the supplied sender mode. The host must reject any
         * implementation that would widen the target beyond that mode.
         */
        setReadOnly: Type.Function(
            [
                collaborationContextSchema,
                collaborationAgentIdSchema,
                collaborationAgentIdSchema,
                Type.Boolean(),
                agentPermissionModeSchema,
            ],
            asyncVoidResultSchema,
        ),
        spawnCapacity: Type.Function(
            [collaborationContextSchema, collaborationAgentIdSchema],
            Type.Promise(collaborationSpawnCapacitySchema),
        ),
    },
    { additionalProperties: false },
);

/** The authoritative host roster. It is separate from message persistence. */
export const collaborationRosterSchema = Type.Object(
    {
        readAgent: Type.Function(
            [collaborationContextSchema, collaborationAgentIdSchema],
            Type.Promise(Type.Union([collaborationAgentSchema, Type.Undefined()])),
        ),
        writeAgent: Type.Function(
            [collaborationContextSchema, collaborationAgentSchema],
            asyncVoidResultSchema,
        ),
        listAgents: Type.Function(
            [
                collaborationContextSchema,
                collaborationAgentIdSchema,
                collaborationAgentPageQuerySchema,
            ],
            Type.Promise(collaborationAgentPageSchema),
        ),
    },
    { additionalProperties: false },
);

/**
 * Internal collaboration persistence contract. Every operation reads the database facade carried
 * by the context, so a caller's `ctx.inTx` boundary is respected automatically.
 */
export const collaborationStoreSchema = Type.Object(
    {
        readMessage: Type.Function(
            [collaborationContextSchema, collaborationMessageIdSchema],
            Type.Promise(Type.Union([collaborationMessageSchema, Type.Undefined()])),
        ),
        writeMessage: Type.Function(
            [collaborationContextSchema, collaborationMessageSchema],
            asyncVoidResultSchema,
        ),
        readObligation: Type.Function(
            [collaborationContextSchema, collaborationObligationIdSchema],
            Type.Promise(Type.Union([collaborationObligationSchema, Type.Undefined()])),
        ),
        writeObligation: Type.Function(
            [collaborationContextSchema, collaborationObligationSchema],
            asyncVoidResultSchema,
        ),
        listObligations: Type.Function(
            [
                collaborationContextSchema,
                collaborationAgentIdSchema,
                collaborationObligationPageQuerySchema,
            ],
            Type.Promise(collaborationObligationPageSchema),
        ),
    },
    { additionalProperties: false },
);

export type CollaborationAuthorization = Static<typeof collaborationAuthorizationSchema>;
export type CollaborationBroker = Static<typeof collaborationBrokerSchema>;
export type CollaborationRoster = Static<typeof collaborationRosterSchema>;
export type CollaborationStore = Static<typeof collaborationStoreSchema>;

export function assertCollaborationAgentPage(
    value: unknown,
): asserts value is CollaborationAgentPage {
    if (!Value.Check(collaborationAgentPageSchema, value)) {
        throw new Error("Collaboration roster returned an invalid agent page.");
    }
}

export function assertCollaborationObligationPage(
    value: unknown,
): asserts value is CollaborationObligationPage {
    if (!Value.Check(collaborationObligationPageSchema, value)) {
        throw new Error("Collaboration store returned an invalid obligation page.");
    }
}

export function assertCollaborationVoidResult(value: unknown, operation: string): void {
    if (value !== undefined) {
        throw new Error(`Collaboration ${operation} must return undefined.`);
    }
}

export function assertCollaborationBrokerAgentResult(
    value: unknown,
): asserts value is Static<typeof collaborationBrokerAgentResultSchema> {
    if (!Value.Check(collaborationBrokerAgentResultSchema, value)) {
        throw new Error("Collaboration broker returned an invalid agent result.");
    }
}

export function assertCollaborationAgentObservation(
    value: unknown,
): asserts value is Static<typeof collaborationAgentObservationSchema> {
    if (!Value.Check(collaborationAgentObservationSchema, value)) {
        throw new Error("Collaboration broker returned an invalid agent observation.");
    }
}

export function assertCollaborationSpawnCapacity(
    value: unknown,
): asserts value is Static<typeof collaborationSpawnCapacitySchema> {
    if (!Value.Check(collaborationSpawnCapacitySchema, value)) {
        throw new Error("Collaboration broker returned invalid spawn capacity.");
    }
}

export function assertCollaborationContext(value: unknown): asserts value is Context {
    if (!Value.Check(collaborationContextSchema, value)) {
        throw new Error("Collaboration context is invalid.");
    }
}
