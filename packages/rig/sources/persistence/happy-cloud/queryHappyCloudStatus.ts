import { Value } from "@sinclair/typebox/value";

import {
    HAPPY_CLOUD_CONTRACT_VERSION,
    happyCloudStatusSchema,
    type HappyCloudStatus,
} from "../../protocol/HappyCloudProtocol.js";
import { happyCloudEnrollment } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function queryHappyCloudStatus(tx: TX): HappyCloudStatus {
    const row = tx.select().from(happyCloudEnrollment).get();
    if (row === undefined) return defaultHappyCloudStatus();
    return Value.Decode(happyCloudStatusSchema, {
        capabilities: {
            friends: { changedAt: row.friendsChangedAtMs, consent: row.friendsConsent },
            group_chats: {
                changedAt: row.groupChatsChangedAtMs,
                consent: row.groupChatsConsent,
            },
            happy_profile: {
                changedAt: row.happyProfileChangedAtMs,
                consent: row.happyProfileConsent,
            },
            live_session_sharing: {
                changedAt: row.liveSessionSharingChangedAtMs,
                consent: row.liveSessionSharingConsent,
            },
            remote_control: {
                changedAt: row.remoteControlChangedAtMs,
                consent: row.remoteControlConsent,
            },
            session_blob_persistence: {
                changedAt: row.sessionBlobPersistenceChangedAtMs,
                consent: row.sessionBlobPersistenceConsent,
            },
        },
        contractVersion: row.contractVersion,
        enrollment: {
            changedAt: row.enrollmentChangedAtMs,
            state: row.enrollmentState,
        },
        profile: {
            changedAt: row.profileChangedAtMs,
            state: row.profileCiphertext === null ? "not_created" : "created",
        },
        updatedAt: row.updatedAtMs,
        version: row.version,
    });
}

export function defaultHappyCloudStatus(): HappyCloudStatus {
    const denied = { changedAt: 0, consent: "denied" as const };
    return {
        capabilities: {
            friends: denied,
            group_chats: denied,
            happy_profile: denied,
            live_session_sharing: denied,
            remote_control: denied,
            session_blob_persistence: denied,
        },
        contractVersion: HAPPY_CLOUD_CONTRACT_VERSION,
        enrollment: { changedAt: 0, state: "not_enrolled" },
        profile: { changedAt: 0, state: "not_created" },
        updatedAt: 0,
        version: 0,
    };
}
