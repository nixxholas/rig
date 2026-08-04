import { Type, type Static } from "@sinclair/typebox";
import { p2pInstanceIdSchema, p2pPublicKeySchema } from "./P2pIdentityProtocol.js";

const exact = { additionalProperties: false } as const;

export const p2pPeerConnectionStatusSchema = Type.Union([
    Type.Literal("connecting"),
    Type.Literal("connected"),
    Type.Literal("unreachable"),
]);
export type P2pPeerConnectionStatus = Static<typeof p2pPeerConnectionStatusSchema>;

export const p2pPeerStatusSchema = Type.Object(
    {
        address: Type.String({ minLength: 1 }),
        error: Type.Optional(Type.String()),
        lastSeenAt: Type.Optional(Type.Number()),
        peerId: Type.Optional(p2pInstanceIdSchema),
        publicKey: Type.Optional(p2pPublicKeySchema),
        rttMs: Type.Optional(Type.Number({ minimum: 0 })),
        status: p2pPeerConnectionStatusSchema,
    },
    exact,
);
export type P2pPeerStatus = Static<typeof p2pPeerStatusSchema>;

export const p2pTransportStatusSchema = Type.Union([
    Type.Object(
        {
            error: Type.String({ minLength: 1 }),
            state: Type.Literal("unavailable"),
            transport: Type.Literal("iroh"),
        },
        exact,
    ),
    Type.Object(
        {
            apiExposed: Type.Boolean(),
            localAddress: Type.String({ minLength: 1 }),
            peers: Type.Array(p2pPeerStatusSchema),
            relayUrl: Type.Optional(Type.String({ minLength: 1 })),
            state: Type.Literal("ready"),
            transport: Type.Literal("iroh"),
        },
        exact,
    ),
]);
export type P2pTransportStatus = Static<typeof p2pTransportStatusSchema>;

export const p2pStatusSchema = Type.Object(
    {
        instanceId: Type.Optional(p2pInstanceIdSchema),
        publicKey: Type.Optional(p2pPublicKeySchema),
        transports: Type.Array(p2pTransportStatusSchema),
    },
    exact,
);
export type P2pStatus = Static<typeof p2pStatusSchema>;

export const p2pStatusChangedEventSchema = Type.Object(
    {
        createdAt: Type.Number(),
        data: Type.Object({ status: p2pStatusSchema }, exact),
        id: Type.String({ minLength: 1 }),
        type: Type.Literal("p2p_status_changed"),
    },
    exact,
);
export type P2pStatusChangedEvent = Static<typeof p2pStatusChangedEventSchema>;
