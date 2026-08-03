import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import {
    HAPPY_CLOUD_CONTRACT_VERSION,
    happyCloudCommandResponseSchema,
    type HappyCloudCapability,
    type HappyCloudCommand,
    type HappyCloudCommandResponse,
} from "../../protocol/HappyCloudProtocol.js";
import {
    happyCloudEnrollment,
    happyCloudMutationReceipts,
    happyCloudSessionBlobs,
} from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { HappyCloudPersistenceError } from "./HappyCloudPersistenceError.js";
import { queryHappyCloudStatus } from "./queryHappyCloudStatus.js";

const MAX_MUTATION_RECEIPTS = 4_096;
export const HAPPY_CLOUD_SESSION_BLOB_LIMIT = 64;

export function happyCloudApplyCommand(
    tx: TX,
    command: HappyCloudCommand,
    now: number,
): HappyCloudCommandResponse {
    return inTx(tx, (tx) => {
        const requestFingerprint = commandFingerprint(command);
        const receipt = tx
            .select({
                requestFingerprint: happyCloudMutationReceipts.requestFingerprint,
                responseJson: happyCloudMutationReceipts.responseJson,
            })
            .from(happyCloudMutationReceipts)
            .where(eq(happyCloudMutationReceipts.mutationId, command.mutationId))
            .get();
        if (receipt !== undefined) {
            if (receipt.requestFingerprint !== requestFingerprint) {
                throw new HappyCloudPersistenceError(
                    "mutation_reused",
                    "That Happy Cloud mutation id was already used for a different command.",
                );
            }
            const original = Value.Decode(
                happyCloudCommandResponseSchema,
                JSON.parse(receipt.responseJson) as unknown,
            );
            const current = queryHappyCloudStatus(tx);
            return current.version === original.status.version ? original : { status: current };
        }

        const current = queryHappyCloudStatus(tx);
        if (current.version !== command.expectedVersion) {
            throw new HappyCloudPersistenceError(
                "version_conflict",
                "Happy Cloud settings changed before this command arrived.",
            );
        }
        ensureRoot(tx, now);
        const nextVersion = current.version + 1;
        applyCommand(tx, command, nextVersion, now);
        const response = { status: queryHappyCloudStatus(tx) };
        const responseJson = JSON.stringify(response);
        tx.insert(happyCloudMutationReceipts)
            .values({
                createdAtMs: now,
                mutationId: command.mutationId,
                requestFingerprint,
                responseJson,
            })
            .run();
        tx.run(sql`DELETE FROM happy_cloud_mutation_receipts
            WHERE seq NOT IN (
                SELECT seq FROM happy_cloud_mutation_receipts
                ORDER BY seq DESC LIMIT ${MAX_MUTATION_RECEIPTS}
            )`);
        return response;
    });
}

function ensureRoot(tx: TX, now: number): void {
    tx.insert(happyCloudEnrollment)
        .values({
            singletonId: 1,
            contractVersion: HAPPY_CLOUD_CONTRACT_VERSION,
            version: 0,
            enrollmentState: "not_enrolled",
            enrollmentChangedAtMs: 0,
            friendsConsent: "denied",
            friendsChangedAtMs: 0,
            groupChatsConsent: "denied",
            groupChatsChangedAtMs: 0,
            liveSessionSharingConsent: "denied",
            liveSessionSharingChangedAtMs: 0,
            remoteControlConsent: "denied",
            remoteControlChangedAtMs: 0,
            sessionBlobPersistenceConsent: "denied",
            sessionBlobPersistenceChangedAtMs: 0,
            happyProfileConsent: "denied",
            happyProfileChangedAtMs: 0,
            profileCiphertext: null,
            profileVersion: null,
            profileChangedAtMs: 0,
            updatedAtMs: now,
        })
        .onConflictDoNothing()
        .run();
}

function applyCommand(tx: TX, command: HappyCloudCommand, nextVersion: number, now: number): void {
    if (command.action === "set_enrollment") {
        const revoking = command.state === "not_enrolled";
        tx.update(happyCloudEnrollment)
            .set({
                enrollmentState: command.state,
                enrollmentChangedAtMs: now,
                ...(revoking
                    ? {
                          friendsConsent: "denied",
                          friendsChangedAtMs: now,
                          groupChatsConsent: "denied",
                          groupChatsChangedAtMs: now,
                          happyProfileConsent: "denied",
                          happyProfileChangedAtMs: now,
                          liveSessionSharingConsent: "denied",
                          liveSessionSharingChangedAtMs: now,
                          profileChangedAtMs: now,
                          profileCiphertext: null,
                          profileVersion: null,
                          remoteControlConsent: "denied",
                          remoteControlChangedAtMs: now,
                          sessionBlobPersistenceConsent: "denied",
                          sessionBlobPersistenceChangedAtMs: now,
                      }
                    : {}),
                updatedAtMs: now,
                version: nextVersion,
            })
            .where(eq(happyCloudEnrollment.singletonId, 1))
            .run();
        if (revoking) tx.delete(happyCloudSessionBlobs).run();
        return;
    }

    const current = queryHappyCloudStatus(tx);
    if (current.enrollment.state !== "enrolled") {
        throw new HappyCloudPersistenceError(
            "not_enrolled",
            "Enroll in Happy Cloud before changing a capability or encrypted payload.",
        );
    }
    if (command.action === "set_capability") {
        const update = capabilityUpdate(command.capability, command.consent, now);
        tx.update(happyCloudEnrollment)
            .set({ ...update, updatedAtMs: now, version: nextVersion })
            .where(eq(happyCloudEnrollment.singletonId, 1))
            .run();
        if (command.consent === "denied" && command.capability === "happy_profile") {
            tx.update(happyCloudEnrollment)
                .set({
                    profileChangedAtMs: now,
                    profileCiphertext: null,
                    profileVersion: null,
                })
                .where(eq(happyCloudEnrollment.singletonId, 1))
                .run();
        }
        if (command.consent === "denied" && command.capability === "session_blob_persistence") {
            tx.delete(happyCloudSessionBlobs).run();
        }
        return;
    }
    if (command.action === "put_profile" || command.action === "delete_profile") {
        requireCapability(current, "happy_profile");
        tx.update(happyCloudEnrollment)
            .set({
                profileChangedAtMs: now,
                profileCiphertext: command.action === "put_profile" ? command.ciphertext : null,
                profileVersion: command.action === "put_profile" ? nextVersion : null,
                updatedAtMs: now,
                version: nextVersion,
            })
            .where(eq(happyCloudEnrollment.singletonId, 1))
            .run();
        return;
    }

    requireCapability(current, "session_blob_persistence");
    if (command.action === "put_session_blob") {
        tx.insert(happyCloudSessionBlobs)
            .values({
                ciphertext: command.ciphertext,
                sessionId: command.sessionId,
                updatedAtMs: now,
                version: nextVersion,
            })
            .onConflictDoUpdate({
                set: {
                    ciphertext: command.ciphertext,
                    updatedAtMs: now,
                    version: nextVersion,
                },
                target: happyCloudSessionBlobs.sessionId,
            })
            .run();
        tx.run(sql`DELETE FROM happy_cloud_session_blobs
            WHERE session_id NOT IN (
                SELECT session_id FROM happy_cloud_session_blobs
                ORDER BY version DESC, session_id DESC
                LIMIT ${HAPPY_CLOUD_SESSION_BLOB_LIMIT}
            )`);
    } else {
        tx.delete(happyCloudSessionBlobs)
            .where(eq(happyCloudSessionBlobs.sessionId, command.sessionId))
            .run();
    }
    tx.update(happyCloudEnrollment)
        .set({ updatedAtMs: now, version: nextVersion })
        .where(eq(happyCloudEnrollment.singletonId, 1))
        .run();
}

function requireCapability(
    status: ReturnType<typeof queryHappyCloudStatus>,
    capability: "happy_profile" | "session_blob_persistence",
): void {
    if (status.capabilities[capability].consent === "granted") return;
    throw new HappyCloudPersistenceError(
        "capability_not_granted",
        `Grant the ${capability.replaceAll("_", " ")} capability before storing ciphertext.`,
    );
}

function capabilityUpdate(
    capability: HappyCloudCapability,
    consent: "denied" | "granted",
    now: number,
): Partial<typeof happyCloudEnrollment.$inferInsert> {
    switch (capability) {
        case "friends":
            return { friendsChangedAtMs: now, friendsConsent: consent };
        case "group_chats":
            return { groupChatsChangedAtMs: now, groupChatsConsent: consent };
        case "live_session_sharing":
            return {
                liveSessionSharingChangedAtMs: now,
                liveSessionSharingConsent: consent,
            };
        case "remote_control":
            return { remoteControlChangedAtMs: now, remoteControlConsent: consent };
        case "session_blob_persistence":
            return {
                sessionBlobPersistenceChangedAtMs: now,
                sessionBlobPersistenceConsent: consent,
            };
        case "happy_profile":
            return { happyProfileChangedAtMs: now, happyProfileConsent: consent };
    }
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

function commandFingerprint(command: HappyCloudCommand): string {
    return createHash("sha256").update(stableJson(command)).digest("hex");
}
