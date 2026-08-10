import { createHash } from "node:crypto";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type { P2pInstanceIdentity } from "../p2p/P2pIdentity.js";
import {
    fastForwardP2pCredentialSnapshotVersion,
    prepareP2pCredentialSnapshotVersion,
    replaceP2pCredentialSnapshot,
} from "../persistence/p2p-credential/p2pCredentialSnapshot.js";
import { type P2pProvisionedProviderRecord } from "../persistence/p2p-credential/P2pProvisionedProviderRecord.js";
import { queryP2pProvisionedProviders } from "../persistence/p2p-credential/queryP2pProvisionedProviders.js";
import {
    p2pCredentialMaterialSchema,
    p2pCredentialSnapshotSchema,
    p2pEncryptedCredentialSnapshotSchema,
    provisionedProviderSchema,
    type P2pCredentialMaterial,
    type P2pCredentialSnapshot,
    type P2pEncryptedCredentialSnapshot,
    type ProvisionedProvider,
    P2P_CREDENTIAL_SNAPSHOT_MAX_BYTES,
} from "../protocol/P2pCredentialProtocol.js";
import { p2pInstanceIdSchema } from "../protocol/P2pIdentityProtocol.js";

const exact = { additionalProperties: false } as const;
const encryptedMaterialEnvelopeSchema = Type.Object(
    {
        algorithm: Type.Literal("nacl_box"),
        ciphertext: Type.String({ minLength: 1 }),
        nonce: Type.String({ minLength: 1 }),
    },
    exact,
);
type EncryptedMaterialEnvelope = Static<typeof encryptedMaterialEnvelopeSchema>;

export interface P2pCredentialDatabase {
    query<T>(ctx: Context, operation: (ctx: Context) => Promise<T>): Promise<T>;
    transaction<T>(ctx: Context, operation: (ctx: Context) => Promise<T>): Promise<T>;
}

export interface P2pCredentialStoreOptions {
    database: P2pCredentialDatabase;
    identity: P2pInstanceIdentity;
    now?: () => number;
}

export interface P2pCredentialReplaceResult {
    changed: boolean;
    version: number;
}

export class P2pCredentialVersionConflictError extends Error {
    readonly currentVersion: number;

    constructor(message: string, currentVersion: number) {
        super(message);
        this.name = "P2pCredentialVersionConflictError";
        this.currentVersion = currentVersion;
    }
}

/**
 * Stores credential snapshots separately for each authenticated Rig owner.
 *
 * Executable material is encrypted to this Rig's own P2P identity before it
 * reaches SQLite. Public provider configuration remains separate for the UI
 * and provider catalog, but is not enough to authenticate with a provider.
 */
export class P2pCredentialStore {
    readonly #database: P2pCredentialDatabase;
    readonly #identity: P2pInstanceIdentity;
    readonly #now: () => number;

    constructor(options: P2pCredentialStoreOptions) {
        this.#database = options.database;
        this.#identity = options.identity;
        this.#now = options.now ?? Date.now;
    }

    async list(ctx: Context, ownerInstanceId: string): Promise<readonly ProvisionedProvider[]> {
        if (!Value.Check(p2pInstanceIdSchema, ownerInstanceId)) {
            throw new Error("The P2P credential owner is invalid.");
        }
        return this.#database.query(ctx, async (ctx) =>
            (await queryP2pProvisionedProviders(ctx, ownerInstanceId)).map((record) =>
                this.#decodeProvider(record),
            ),
        );
    }

    async listAll(ctx: Context): Promise<ReadonlyMap<string, readonly ProvisionedProvider[]>> {
        const grouped = new Map<string, ProvisionedProvider[]>();
        for (const record of await this.#database.query(ctx, async (ctx) =>
            queryP2pProvisionedProviders(ctx),
        )) {
            const providers = grouped.get(record.ownerInstanceId) ?? [];
            providers.push(this.#decodeProvider(record));
            grouped.set(record.ownerInstanceId, providers);
        }
        return grouped;
    }

    /**
     * Persists an already-authenticated owner's complete decoded snapshot.
     */
    async replace(
        ctx: Context,
        ownerInstanceId: string,
        snapshot: P2pCredentialSnapshot,
    ): Promise<P2pCredentialReplaceResult> {
        if (!Value.Check(p2pCredentialSnapshotSchema, snapshot)) {
            throw new Error("The P2P credential snapshot is invalid.");
        }
        if (snapshot.owner.instanceId !== ownerInstanceId) {
            throw new Error(
                "The P2P credential snapshot owner does not match its authenticated owner.",
            );
        }
        const sourceDigest = snapshotDigest(snapshot);
        const now = this.#now();
        const records = snapshot.providers.map(
            (provider, position): P2pProvisionedProviderRecord => ({
                createdAt: now,
                encryptedMaterialJson:
                    provider.material === undefined
                        ? null
                        : JSON.stringify(this.#encryptMaterial(provider.material)),
                ownerInstanceId,
                position,
                providerId: provider.providerId,
                publicConfigJson: JSON.stringify(provider.config),
                sourceDigest,
                updatedAt: now,
                visibility: provider.visibility,
            }),
        );
        const result = await this.#database.transaction(ctx, (ctx) =>
            replaceP2pCredentialSnapshot(ctx, {
                ownerInstanceId,
                providers: records,
                sourceDigest,
                updatedAt: now,
                version: snapshot.version,
            }),
        );
        switch (result.outcome) {
            case "changed":
                return { changed: true, version: result.version };
            case "unchanged":
                return { changed: false, version: result.version };
            case "stale":
                throw new P2pCredentialVersionConflictError(
                    "The P2P credential snapshot is older than saved state.",
                    result.version,
                );
            case "conflict":
                throw new P2pCredentialVersionConflictError(
                    "The P2P credential snapshot conflicts with the saved version.",
                    result.version,
                );
        }
    }

    /**
     * Assigns the next durable version to this Rig's outgoing snapshot. Unchanged credentials keep
     * their version across reconnects and restarts; changed or empty snapshots advance it.
     */
    async prepareOwnSnapshot(
        ctx: Context,
        snapshot: P2pCredentialSnapshot,
    ): Promise<P2pCredentialSnapshot> {
        if (
            !Value.Check(p2pCredentialSnapshotSchema, snapshot) ||
            snapshot.owner.instanceId !== this.#identity.instanceId ||
            snapshot.owner.publicKey !== this.#identity.publicKey
        ) {
            throw new Error("This Rig may only version its own credential snapshot.");
        }
        const sourceDigest = snapshotDigest(snapshot);
        const version = await this.#database.transaction(ctx, (ctx) =>
            prepareP2pCredentialSnapshotVersion(ctx, {
                ownerInstanceId: this.#identity.instanceId,
                sourceDigest,
                updatedAt: this.#now(),
            }),
        );
        return { ...snapshot, version };
    }

    /**
     * Advances this Rig's outgoing snapshot above an authenticated receiver's authoritative
     * version after local durable version state was reset. The credential payload must still be
     * the current locally prepared payload, so a concurrent credential change cannot be reverted.
     */
    async fastForwardOwnSnapshot(
        ctx: Context,
        snapshot: P2pCredentialSnapshot,
        receiverVersion: number,
    ): Promise<P2pCredentialSnapshot> {
        if (
            !Value.Check(p2pCredentialSnapshotSchema, snapshot) ||
            snapshot.owner.instanceId !== this.#identity.instanceId ||
            snapshot.owner.publicKey !== this.#identity.publicKey
        ) {
            throw new Error("This Rig may only reconcile its own credential snapshot.");
        }
        if (
            !Number.isSafeInteger(receiverVersion) ||
            receiverVersion < 1 ||
            receiverVersion >= Number.MAX_SAFE_INTEGER
        ) {
            throw new Error("The remote P2P credential version cannot be reconciled.");
        }
        const sourceDigest = snapshotDigest(snapshot);
        const result = await this.#database.transaction(ctx, (ctx) =>
            fastForwardP2pCredentialSnapshotVersion(ctx, {
                ownerInstanceId: this.#identity.instanceId,
                receiverVersion,
                snapshotVersion: snapshot.version,
                sourceDigest,
                updatedAt: this.#now(),
            }),
        );
        if (result.outcome === "source_changed") {
            throw new Error(
                "The local P2P credential snapshot changed while its version was reconciled.",
            );
        }
        return { ...snapshot, version: result.version };
    }

    /**
     * Decrypts and applies a remote snapshot only when its envelope, sender,
     * and decoded owner all describe the same authenticated Rig.
     */
    async replaceEncrypted(
        ctx: Context,
        authenticatedOwnerId: string,
        senderPublicKey: string,
        envelope: P2pEncryptedCredentialSnapshot,
    ): Promise<P2pCredentialReplaceResult> {
        if (!Value.Check(p2pInstanceIdSchema, authenticatedOwnerId)) {
            throw new Error("The authenticated P2P credential owner is invalid.");
        }
        if (!Value.Check(p2pEncryptedCredentialSnapshotSchema, envelope)) {
            throw new Error("The encrypted P2P credential snapshot is invalid.");
        }
        if (
            envelope.owner.instanceId !== authenticatedOwnerId ||
            envelope.owner.publicKey !== senderPublicKey
        ) {
            throw new Error("The encrypted P2P credential snapshot is not owned by its sender.");
        }
        const snapshot = decodeJson(
            this.#identity.decryptFrom(
                { ciphertext: envelope.ciphertext, nonce: envelope.nonce },
                senderPublicKey,
            ),
            "P2P credential snapshot",
        );
        if (!Value.Check(p2pCredentialSnapshotSchema, snapshot)) {
            throw new Error("The decrypted P2P credential snapshot is invalid.");
        }
        if (
            Buffer.byteLength(JSON.stringify(snapshot), "utf8") > P2P_CREDENTIAL_SNAPSHOT_MAX_BYTES
        ) {
            throw new Error("The P2P credential snapshot exceeds the 5 MiB limit.");
        }
        if (
            snapshot.owner.instanceId !== envelope.owner.instanceId ||
            snapshot.owner.publicKey !== envelope.owner.publicKey
        ) {
            throw new Error(
                "The decrypted P2P credential snapshot owner does not match its envelope.",
            );
        }
        return this.replace(ctx, authenticatedOwnerId, snapshot);
    }

    /**
     * Encrypts a locally owned snapshot for one peer without exposing
     * credential material in the P2P status or configuration surfaces.
     */
    encryptForPeer(
        snapshot: P2pCredentialSnapshot,
        recipientPublicKey: string,
    ): P2pEncryptedCredentialSnapshot {
        if (!Value.Check(p2pCredentialSnapshotSchema, snapshot)) {
            throw new Error("The P2P credential snapshot is invalid.");
        }
        const encoded = new TextEncoder().encode(JSON.stringify(snapshot));
        if (encoded.byteLength > P2P_CREDENTIAL_SNAPSHOT_MAX_BYTES) {
            throw new Error("The P2P credential snapshot exceeds the 5 MiB limit.");
        }
        if (
            snapshot.owner.instanceId !== this.#identity.instanceId ||
            snapshot.owner.publicKey !== this.#identity.publicKey
        ) {
            throw new Error("This Rig may only encrypt its own credential snapshot.");
        }
        const encrypted = this.#identity.encryptFor(encoded, recipientPublicKey);
        const envelope: P2pEncryptedCredentialSnapshot = {
            algorithm: "nacl_box",
            ciphertext: encrypted.ciphertext,
            nonce: encrypted.nonce,
            owner: {
                instanceId: this.#identity.instanceId,
                publicKey: this.#identity.publicKey,
            },
        };
        if (!Value.Check(p2pEncryptedCredentialSnapshotSchema, envelope)) {
            throw new Error("The encrypted P2P credential snapshot is invalid.");
        }
        return envelope;
    }

    #decodeProvider(record: P2pProvisionedProviderRecord): ProvisionedProvider {
        const config = parseJson(record.publicConfigJson, "P2P provisioned provider configuration");
        const material =
            record.encryptedMaterialJson === null
                ? undefined
                : this.#decryptMaterial(record.encryptedMaterialJson);
        const provider: unknown = {
            config,
            ...(material === undefined ? {} : { material }),
            providerId: record.providerId,
            visibility: record.visibility,
        };
        if (!Value.Check(provisionedProviderSchema, provider)) {
            throw new Error("The saved P2P provisioned provider is invalid.");
        }
        return provider;
    }

    #decryptMaterial(serialized: string): P2pCredentialMaterial {
        const envelope = parseJson(serialized, "P2P encrypted credential material");
        if (!Value.Check(encryptedMaterialEnvelopeSchema, envelope)) {
            throw new Error("The saved P2P credential material envelope is invalid.");
        }
        const material = decodeJson(
            this.#identity.decryptFrom(envelope, this.#identity.publicKey),
            "P2P credential material",
        );
        if (!Value.Check(p2pCredentialMaterialSchema, material)) {
            throw new Error("The saved P2P credential material is invalid.");
        }
        return material;
    }

    #encryptMaterial(material: P2pCredentialMaterial): EncryptedMaterialEnvelope {
        if (!Value.Check(p2pCredentialMaterialSchema, material)) {
            throw new Error("The P2P credential material is invalid.");
        }
        const encrypted = this.#identity.encryptFor(
            new TextEncoder().encode(JSON.stringify(material)),
            this.#identity.publicKey,
        );
        return { algorithm: "nacl_box", ...encrypted };
    }
}

function parseJson(value: string, label: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        throw new Error(`The ${label} is not valid JSON.`);
    }
}

function decodeJson(value: Uint8Array, label: string): unknown {
    try {
        return JSON.parse(new TextDecoder().decode(value));
    } catch {
        throw new Error(`The ${label} is not valid JSON.`);
    }
}

function snapshotDigest(snapshot: P2pCredentialSnapshot): string {
    return createHash("sha256")
        .update(JSON.stringify({ owner: snapshot.owner, providers: snapshot.providers }))
        .digest("hex");
}
