import { eq } from "drizzle-orm";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { p2pInstanceIdSchema } from "../../protocol/P2pIdentityProtocol.js";
import { p2pCredentialSnapshots } from "../database/schema.js";
import { inDatabase } from "../database/inDatabase.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";
import {
    p2pProvisionedProviderRecordSchema,
    type P2pProvisionedProviderRecord,
} from "./P2pProvisionedProviderRecord.js";
import { p2pProvisionedProvidersReplace } from "./p2pProvisionedProvidersReplace.js";

const exact = { additionalProperties: false } as const;

export const p2pCredentialSnapshotRecordSchema = Type.Object(
    {
        ownerInstanceId: p2pInstanceIdSchema,
        sourceDigest: Type.String({
            maxLength: 64,
            minLength: 64,
            pattern: "^[a-f0-9]{64}$",
        }),
        updatedAt: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        version: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
    },
    exact,
);
export type P2pCredentialSnapshotRecord = Static<typeof p2pCredentialSnapshotRecordSchema>;

export type P2pCredentialSnapshotReplaceResult =
    | { outcome: "changed"; version: number }
    | { outcome: "conflict"; version: number }
    | { outcome: "stale"; version: number }
    | { outcome: "unchanged"; version: number };

export type P2pCredentialSnapshotFastForwardResult =
    | { outcome: "advanced"; version: number }
    | { outcome: "source_changed" };

export async function queryP2pCredentialSnapshot(
    tx: DatabaseScope,
    ownerInstanceId: string,
): Promise<P2pCredentialSnapshotRecord | undefined> {
    assertOwner(ownerInstanceId);
    return await inDatabase(tx, async (tx) => {
        const row = await tx
            .select()
            .from(p2pCredentialSnapshots)
            .where(eq(p2pCredentialSnapshots.ownerInstanceId, ownerInstanceId))
            .get();
        if (row === undefined) return undefined;
        const record: unknown = {
            ownerInstanceId: row.ownerInstanceId,
            sourceDigest: row.sourceDigest,
            updatedAt: row.updatedAtMs,
            version: row.version,
        };
        if (!Value.Check(p2pCredentialSnapshotRecordSchema, record)) {
            throw new Error("The saved P2P credential snapshot is invalid.");
        }
        return record;
    });
}

export async function replaceP2pCredentialSnapshot(
    tx: DatabaseScope,
    input: {
        ownerInstanceId: string;
        providers: readonly P2pProvisionedProviderRecord[];
        sourceDigest: string;
        updatedAt: number;
        version: number;
    },
): Promise<P2pCredentialSnapshotReplaceResult> {
    assertOwner(input.ownerInstanceId);
    assertSnapshotVersion(input.version);
    assertSourceDigest(input.sourceDigest);
    if (
        input.providers.some(
            (provider) =>
                !Value.Check(p2pProvisionedProviderRecordSchema, provider) ||
                provider.ownerInstanceId !== input.ownerInstanceId,
        )
    ) {
        throw new Error("The P2P provisioned provider does not belong to its owner.");
    }
    if (input.providers.some((provider) => provider.sourceDigest !== input.sourceDigest)) {
        throw new Error("The P2P credential snapshot digest does not match its providers.");
    }
    return await inTx(tx, async (tx) => {
        const current = await queryP2pCredentialSnapshot(tx, input.ownerInstanceId);
        if (current !== undefined) {
            if (input.version < current.version) {
                return { outcome: "stale", version: current.version };
            }
            if (input.version === current.version) {
                return current.sourceDigest === input.sourceDigest
                    ? { outcome: "unchanged", version: current.version }
                    : { outcome: "conflict", version: current.version };
            }
        }
        await p2pProvisionedProvidersReplace(tx, input.ownerInstanceId, input.providers);
        await writeSnapshot(tx, input);
        return { outcome: "changed", version: input.version };
    });
}

export async function prepareP2pCredentialSnapshotVersion(
    tx: DatabaseScope,
    input: {
        ownerInstanceId: string;
        sourceDigest: string;
        updatedAt: number;
    },
): Promise<number> {
    assertOwner(input.ownerInstanceId);
    assertSourceDigest(input.sourceDigest);
    return await inTx(tx, async (tx) => {
        const current = await queryP2pCredentialSnapshot(tx, input.ownerInstanceId);
        if (current?.sourceDigest === input.sourceDigest) return current.version;
        const version = (current?.version ?? 0) + 1;
        await writeSnapshot(tx, {
            ...input,
            version,
        });
        return version;
    });
}

export async function fastForwardP2pCredentialSnapshotVersion(
    tx: DatabaseScope,
    input: {
        ownerInstanceId: string;
        receiverVersion: number;
        snapshotVersion: number;
        sourceDigest: string;
        updatedAt: number;
    },
): Promise<P2pCredentialSnapshotFastForwardResult> {
    assertOwner(input.ownerInstanceId);
    assertSnapshotVersion(input.receiverVersion);
    assertSnapshotVersion(input.snapshotVersion);
    assertSourceDigest(input.sourceDigest);
    return await inTx(tx, async (tx) => {
        const current = await queryP2pCredentialSnapshot(tx, input.ownerInstanceId);
        if (current !== undefined && current.sourceDigest !== input.sourceDigest) {
            return { outcome: "source_changed" };
        }
        const version = Math.max(
            input.receiverVersion + 1,
            input.snapshotVersion,
            current?.version ?? 0,
        );
        if (current?.version === version) return { outcome: "advanced", version };
        await writeSnapshot(tx, {
            ownerInstanceId: input.ownerInstanceId,
            sourceDigest: input.sourceDigest,
            updatedAt: input.updatedAt,
            version,
        });
        return { outcome: "advanced", version };
    });
}

async function writeSnapshot(
    tx: DatabaseScope,
    input: {
        ownerInstanceId: string;
        sourceDigest: string;
        updatedAt: number;
        version: number;
    },
): Promise<void> {
    await tx
        .insert(p2pCredentialSnapshots)
        .values({
            ownerInstanceId: input.ownerInstanceId,
            sourceDigest: input.sourceDigest,
            updatedAtMs: input.updatedAt,
            version: input.version,
        })
        .onConflictDoUpdate({
            set: {
                sourceDigest: input.sourceDigest,
                updatedAtMs: input.updatedAt,
                version: input.version,
            },
            target: p2pCredentialSnapshots.ownerInstanceId,
        })
        .run();
}

function assertOwner(ownerInstanceId: string): void {
    if (!Value.Check(p2pInstanceIdSchema, ownerInstanceId)) {
        throw new Error("The authenticated P2P credential owner is invalid.");
    }
}

function assertSnapshotVersion(version: number): void {
    if (!Number.isSafeInteger(version) || version < 0 || version >= Number.MAX_SAFE_INTEGER) {
        throw new Error("The P2P credential snapshot version is invalid.");
    }
}

function assertSourceDigest(sourceDigest: string): void {
    if (!/^[a-f0-9]{64}$/u.test(sourceDigest)) {
        throw new Error("The P2P credential snapshot digest is invalid.");
    }
}
