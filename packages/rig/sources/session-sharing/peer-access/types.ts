import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;
const identifierSchema = Type.String({ maxLength: 256, minLength: 1 });
const epochSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 });
const timestampSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });

/**
 * What one friend may do in a shared session beyond reading the transcript.
 *
 * Only capabilities Rig actually enforces appear here. Widening this union
 * later is one line; shipping a literal nothing enforces is a promise the
 * product cannot take back.
 */
export const peerCapabilitySchema = Type.Union([Type.Literal("terminal_view")]);
export type PeerCapability = Static<typeof peerCapabilitySchema>;

export const PEER_CAPABILITIES: readonly PeerCapability[] = ["terminal_view"];

export const peerCapabilityStateSchema = Type.Union([
    Type.Literal("active"),
    Type.Literal("revoked"),
]);
export type PeerCapabilityState = Static<typeof peerCapabilityStateSchema>;

/**
 * One capability the owner granted to one member at one grant epoch.
 *
 * The epoch is part of the identity rather than a field to compare later: a
 * revoke-and-reinvite bumps the member's epoch, so a grant written under the
 * old one can never resolve again.
 */
export const peerCapabilityGrantSchema = Type.Object(
    {
        capability: peerCapabilitySchema,
        grantEpoch: epochSchema,
        grantedAt: timestampSchema,
        revokedAt: Type.Optional(timestampSchema),
        shareId: identifierSchema,
        shareMemberId: identifierSchema,
        state: peerCapabilityStateSchema,
    },
    exact,
);
export type PeerCapabilityGrant = Static<typeof peerCapabilityGrantSchema>;

/** What a peer asked to do, named the way an audit row and a denial both need. */
export const peerActionSchema = Type.Object(
    {
        /** Free-form subject of the action, such as a terminal identifier. */
        detail: Type.Optional(Type.String({ maxLength: 512, minLength: 1 })),
        /** Verb, in the vocabulary of the capability, such as `attach`. */
        name: Type.String({ maxLength: 128, minLength: 1 }),
    },
    exact,
);
export type PeerAction = Static<typeof peerActionSchema>;

export const peerActionOutcomeSchema = Type.Union([
    Type.Literal("allowed"),
    Type.Literal("denied"),
]);
export type PeerActionOutcome = Static<typeof peerActionOutcomeSchema>;

export const peerActivityEntrySchema = Type.Object(
    {
        action: Type.String({ maxLength: 128, minLength: 1 }),
        capability: peerCapabilitySchema,
        createdAt: timestampSchema,
        detail: Type.Optional(Type.String({ maxLength: 512, minLength: 1 })),
        grantEpoch: epochSchema,
        outcome: peerActionOutcomeSchema,
        seq: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
        shareId: identifierSchema,
        shareMemberId: identifierSchema,
    },
    exact,
);
export type PeerActivityEntry = Static<typeof peerActivityEntrySchema>;

/**
 * Why a peer action was refused, in the words the owner and the friend read.
 *
 * A denial is always a complete English sentence. There is no code a UI has to
 * translate, because every place this reaches renders it verbatim.
 */
export interface PeerCapabilityDenial {
    readonly outcome: "denied";
    readonly reason: string;
}

export interface PeerCapabilityAllowance {
    readonly capability: PeerCapability;
    /** Mode the action runs under: the session's mode reduced to the ceiling. */
    readonly effectiveMode: import("../../permissions/PermissionMode.js").PermissionMode;
    readonly grantEpoch: number;
    readonly outcome: "allowed";
    /** Revision this decision was made against; a long-lived channel re-checks it. */
    readonly revision: number;
    readonly shareId: string;
    readonly shareMemberId: string;
}

export type PeerCapabilityDecision = PeerCapabilityAllowance | PeerCapabilityDenial;
