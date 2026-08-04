import { randomBytes } from "node:crypto";

import type { RecvStream, SendStream } from "@number0/iroh/index.js";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    encodeBase64Url,
    p2pInstanceIdSchema,
    p2pPublicKeySchema,
    verifyP2pSignature,
    type P2pInstanceIdentity,
    type P2pPeerIdentity,
} from "./P2pIdentity.js";

const HELLO_LIFETIME_MS = 5 * 60 * 1_000;
const MAXIMUM_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAXIMUM_HELLO_BYTES = 8 * 1_024;
const endpointIdSchema = Type.String({
    maxLength: 64,
    minLength: 64,
    pattern: "^[0-9a-f]{64}$",
});
const nonceSchema = Type.String({
    maxLength: 43,
    minLength: 43,
    pattern: "^[A-Za-z0-9_-]+$",
});
const signatureSchema = Type.String({
    maxLength: 86,
    minLength: 86,
    pattern: "^[A-Za-z0-9_-]+$",
});
const announcementSchema = Type.Object(
    {
        endpointId: endpointIdSchema,
        expiresAt: Type.Integer({ minimum: 0 }),
        instanceId: p2pInstanceIdSchema,
        issuedAt: Type.Integer({ minimum: 0 }),
        nonce: nonceSchema,
        publicKey: p2pPublicKeySchema,
        signature: signatureSchema,
        version: Type.Literal(1),
    },
    { additionalProperties: false },
);
type Announcement = Static<typeof announcementSchema>;

const proofSchema = Type.Object(
    {
        expiresAt: Type.Integer({ minimum: 0 }),
        initiatorEndpointId: endpointIdSchema,
        initiatorNonce: nonceSchema,
        instanceId: p2pInstanceIdSchema,
        issuedAt: Type.Integer({ minimum: 0 }),
        publicKey: p2pPublicKeySchema,
        responderEndpointId: endpointIdSchema,
        responderNonce: nonceSchema,
        role: Type.Union([Type.Literal("initiator"), Type.Literal("responder")]),
        signature: signatureSchema,
        transport: Type.Literal("iroh"),
        version: Type.Literal(1),
    },
    { additionalProperties: false },
);
export type IrohHelloProof = Static<typeof proofSchema>;
const finishSchema = Type.Object(
    {
        signature: signatureSchema,
        version: Type.Literal(1),
    },
    { additionalProperties: false },
);
export type IrohHelloFinish = Static<typeof finishSchema>;

export interface IrohHelloContext {
    initiatorEndpointId: string;
    initiatorNonce: string;
    responderEndpointId: string;
    responderNonce: string;
}

interface HelloOptions {
    commitPeer?: (identity: P2pPeerIdentity, endpointId: string) => Promise<void>;
    identity: P2pInstanceIdentity;
    localEndpointId: string;
    now?: () => number;
    randomNonce?: () => string;
    remoteEndpointId: string;
    validatePeer?: (identity: P2pPeerIdentity, endpointId: string) => Promise<void>;
}

export async function runIrohInitiatorHello(
    recv: RecvStream,
    send: SendStream,
    options: HelloOptions,
): Promise<P2pPeerIdentity> {
    const now = options.now ?? Date.now;
    const initiatorNonce = (options.randomNonce ?? createNonce)();
    await writeJson(
        send,
        createAnnouncement(options.identity, options.localEndpointId, initiatorNonce, now()),
        announcementSchema,
    );
    const responderProof = await readJson(recv, proofSchema);
    const context: IrohHelloContext = {
        initiatorEndpointId: options.localEndpointId,
        initiatorNonce,
        responderEndpointId: options.remoteEndpointId,
        responderNonce: responderProof.responderNonce,
    };
    const remoteIdentity = verifyIrohHelloProof(responderProof, "responder", context, now());
    await options.validatePeer?.(remoteIdentity, options.remoteEndpointId);
    await writeJson(
        send,
        createIrohHelloProof(options.identity, "initiator", context, now()),
        proofSchema,
    );
    await send.finish();
    const finish = await readJson(recv, finishSchema);
    verifyIrohHelloFinish(finish, remoteIdentity, options.identity, context);
    await options.commitPeer?.(remoteIdentity, options.remoteEndpointId);
    return remoteIdentity;
}

export async function runIrohResponderHello(
    recv: RecvStream,
    send: SendStream,
    options: HelloOptions,
): Promise<P2pPeerIdentity> {
    const now = options.now ?? Date.now;
    const announcement = await readJson(recv, announcementSchema);
    const announcedIdentity = verifyAnnouncement(announcement, options.remoteEndpointId, now());
    const context: IrohHelloContext = {
        initiatorEndpointId: options.remoteEndpointId,
        initiatorNonce: announcement.nonce,
        responderEndpointId: options.localEndpointId,
        responderNonce: (options.randomNonce ?? createNonce)(),
    };
    await writeJson(
        send,
        createIrohHelloProof(options.identity, "responder", context, now()),
        proofSchema,
    );
    const initiatorProof = await readJson(recv, proofSchema);
    const remoteIdentity = verifyIrohHelloProof(initiatorProof, "initiator", context, now());
    if (
        remoteIdentity.instanceId !== announcedIdentity.instanceId ||
        remoteIdentity.publicKey !== announcedIdentity.publicKey
    ) {
        throw new Error("The peer changed its P2P identity during the signed hello.");
    }
    await options.validatePeer?.(remoteIdentity, options.remoteEndpointId);
    await options.commitPeer?.(remoteIdentity, options.remoteEndpointId);
    await writeJson(
        send,
        createIrohHelloFinish(options.identity, remoteIdentity, context),
        finishSchema,
    );
    await send.finish();
    return remoteIdentity;
}

export function createIrohHelloProof(
    identity: P2pInstanceIdentity,
    role: IrohHelloProof["role"],
    context: IrohHelloContext,
    issuedAt: number,
): IrohHelloProof {
    const unsigned = {
        expiresAt: issuedAt + HELLO_LIFETIME_MS,
        ...context,
        instanceId: identity.instanceId,
        issuedAt,
        publicKey: identity.publicKey,
        role,
        transport: "iroh" as const,
        version: 1 as const,
    };
    return {
        ...unsigned,
        signature: identity.sign(proofMessage(unsigned)),
    };
}

export function verifyIrohHelloProof(
    proof: IrohHelloProof,
    role: IrohHelloProof["role"],
    context: IrohHelloContext,
    now: number,
): P2pPeerIdentity {
    if (!Value.Check(proofSchema, proof)) {
        throw new Error("The peer returned an invalid signed P2P hello.");
    }
    if (
        proof.role !== role ||
        proof.initiatorEndpointId !== context.initiatorEndpointId ||
        proof.responderEndpointId !== context.responderEndpointId ||
        proof.initiatorNonce !== context.initiatorNonce ||
        proof.responderNonce !== context.responderNonce
    ) {
        throw new Error("The peer's signed P2P hello is bound to another connection.");
    }
    verifyLifetime(proof.issuedAt, proof.expiresAt, now);
    const { signature, ...unsigned } = proof;
    if (!verifyP2pSignature(proofMessage(unsigned), signature, proof.publicKey)) {
        throw new Error("The peer's signed P2P hello could not be verified.");
    }
    return { instanceId: proof.instanceId, publicKey: proof.publicKey };
}

export function createIrohHelloFinish(
    responderIdentity: P2pInstanceIdentity,
    initiatorIdentity: P2pPeerIdentity,
    context: IrohHelloContext,
): IrohHelloFinish {
    return {
        signature: responderIdentity.sign(
            finishMessage(responderIdentity, initiatorIdentity, context),
        ),
        version: 1,
    };
}

export function verifyIrohHelloFinish(
    finish: IrohHelloFinish,
    responderIdentity: P2pPeerIdentity,
    initiatorIdentity: P2pPeerIdentity,
    context: IrohHelloContext,
): void {
    if (!Value.Check(finishSchema, finish)) {
        throw new Error("The peer returned an invalid P2P hello confirmation.");
    }
    if (
        !verifyP2pSignature(
            finishMessage(responderIdentity, initiatorIdentity, context),
            finish.signature,
            responderIdentity.publicKey,
        )
    ) {
        throw new Error("The peer did not confirm the signed P2P hello.");
    }
}

function createAnnouncement(
    identity: P2pInstanceIdentity,
    endpointId: string,
    nonce: string,
    issuedAt: number,
): Announcement {
    const unsigned = {
        endpointId,
        expiresAt: issuedAt + HELLO_LIFETIME_MS,
        instanceId: identity.instanceId,
        issuedAt,
        nonce,
        publicKey: identity.publicKey,
        version: 1 as const,
    };
    return {
        ...unsigned,
        signature: identity.sign(announcementMessage(unsigned)),
    };
}

function verifyAnnouncement(
    announcement: Announcement,
    endpointId: string,
    now: number,
): P2pPeerIdentity {
    if (announcement.endpointId !== endpointId) {
        throw new Error("The peer signed a different Iroh endpoint ID.");
    }
    verifyLifetime(announcement.issuedAt, announcement.expiresAt, now);
    const { signature, ...unsigned } = announcement;
    if (!verifyP2pSignature(announcementMessage(unsigned), signature, announcement.publicKey)) {
        throw new Error("The peer's P2P identity announcement could not be verified.");
    }
    return {
        instanceId: announcement.instanceId,
        publicKey: announcement.publicKey,
    };
}

function verifyLifetime(issuedAt: number, expiresAt: number, now: number): void {
    if (expiresAt <= issuedAt || expiresAt - issuedAt > HELLO_LIFETIME_MS) {
        throw new Error("The peer's signed P2P hello has an invalid lifetime.");
    }
    if (issuedAt > now + MAXIMUM_CLOCK_SKEW_MS) {
        throw new Error("The peer's clock differs from this machine's by more than five minutes.");
    }
    if (expiresAt < now - MAXIMUM_CLOCK_SKEW_MS) {
        throw new Error(
            "The peer's signed P2P hello has expired, or its clock differs by more than five minutes.",
        );
    }
}

function announcementMessage(announcement: Omit<Announcement, "signature">): Uint8Array {
    return Buffer.from(
        JSON.stringify([
            "rig-p2p-announcement-v1",
            announcement.instanceId,
            announcement.publicKey,
            announcement.endpointId,
            announcement.issuedAt,
            announcement.expiresAt,
            announcement.nonce,
        ]),
        "utf8",
    );
}

function proofMessage(proof: Omit<IrohHelloProof, "signature">): Uint8Array {
    return Buffer.from(
        JSON.stringify([
            "rig-p2p-proof-v1",
            proof.role,
            proof.instanceId,
            proof.publicKey,
            proof.issuedAt,
            proof.expiresAt,
            proof.transport,
            proof.initiatorEndpointId,
            proof.responderEndpointId,
            proof.initiatorNonce,
            proof.responderNonce,
        ]),
        "utf8",
    );
}

function finishMessage(
    responderIdentity: P2pPeerIdentity,
    initiatorIdentity: P2pPeerIdentity,
    context: IrohHelloContext,
): Uint8Array {
    return Buffer.from(
        JSON.stringify([
            "rig-p2p-finish-v1",
            initiatorIdentity.instanceId,
            initiatorIdentity.publicKey,
            responderIdentity.instanceId,
            responderIdentity.publicKey,
            context.initiatorEndpointId,
            context.responderEndpointId,
            context.initiatorNonce,
            context.responderNonce,
        ]),
        "utf8",
    );
}

async function readJson(recv: RecvStream, schema: typeof announcementSchema): Promise<Announcement>;
async function readJson(recv: RecvStream, schema: typeof proofSchema): Promise<IrohHelloProof>;
async function readJson(recv: RecvStream, schema: typeof finishSchema): Promise<IrohHelloFinish>;
async function readJson(
    recv: RecvStream,
    schema: typeof announcementSchema | typeof finishSchema | typeof proofSchema,
): Promise<Announcement | IrohHelloFinish | IrohHelloProof> {
    const length = Buffer.from(await recv.readExact(4)).readUInt32BE(0);
    if (length === 0 || length > MAXIMUM_HELLO_BYTES) {
        throw new Error("The peer returned an invalid P2P hello frame.");
    }
    const source = Buffer.from(await recv.readExact(length)).toString("utf8");
    let parsed: unknown;
    try {
        parsed = JSON.parse(source);
    } catch {
        throw new Error("The peer returned malformed P2P hello data.");
    }
    return Value.Decode(schema, parsed) as Announcement | IrohHelloFinish | IrohHelloProof;
}

async function writeJson(
    send: SendStream,
    value: Announcement | IrohHelloFinish | IrohHelloProof,
    schema: typeof announcementSchema | typeof finishSchema | typeof proofSchema,
): Promise<void> {
    const encoded = Buffer.from(JSON.stringify(Value.Encode(schema, value)), "utf8");
    if (encoded.byteLength === 0 || encoded.byteLength > MAXIMUM_HELLO_BYTES) {
        throw new Error("The signed P2P hello is too large.");
    }
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(encoded.byteLength, 0);
    await send.writeAll([...length, ...encoded]);
}

function createNonce(): string {
    return encodeBase64Url(randomBytes(32));
}
