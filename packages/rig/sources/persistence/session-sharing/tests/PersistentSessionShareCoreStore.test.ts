import { describe, expect, it, vi } from "vitest";

import { FakeSessionShareTransport } from "../../../session-sharing/FakeSessionShareTransport.js";
import { SessionShareService } from "../../../session-sharing/SessionShareService.js";
import { sessions } from "../../database/schema.js";
import { createSessionDatabaseFixture } from "../../database/tests/createSessionDatabaseFixture.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { querySessionShareFriendMessages } from "../querySessionShareFriendMessages.js";
import { querySessionShareOutbox } from "../querySessionShareOutbox.js";
import { PersistentSessionShareCoreStore } from "../PersistentSessionShareCoreStore.js";

describe("PersistentSessionShareCoreStore with the deterministic transport", () => {
    it("recovers publication after restart and commits friend messages before notifying memory", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-session-share-core-"));
        const path = join(directory, "sessions.sqlite");
        createSessionDatabaseFixture(path);
        const opened = openSessionDatabase(path);
        const database = opened.database;
        const transport = new FakeSessionShareTransport();
        const delivered = vi.fn();
        const ids = ["share-1", "member-1", "message-1", "unused-message-id"];
        const store = new PersistentSessionShareCoreStore({
            idFactory: () => ids.shift()!,
            now: () => 10,
            tx: () => database,
        });
        const service = new SessionShareService({
            deliverFriendMessage: delivered,
            idFactory: () => ids.shift()!,
            store,
            transport,
        });

        try {
            const share = await service.create({
                friends: [{ displayName: "Friend", murmurPeerId: "peer-friend" }],
                includeFriendMessagesInModel: false,
                ownerPeerId: "peer-owner",
                ownerSessionId: "session-1",
            });
            expect(
                querySessionShareOutbox(database, { limit: 100, shareId: share.shareId }),
            ).toHaveLength(0);
            service.close();

            const restarted = new SessionShareService({
                deliverFriendMessage: delivered,
                idFactory: () => ids.shift()!,
                store,
                transport,
            });
            await restarted.recover();
            const member = share.members[0]!;
            await transport.postMember({
                clientMessageId: "client-1",
                displayName: "Friend",
                grant: {
                    grantEpoch: member.grantEpoch,
                    murmurPeerId: member.murmurPeerId,
                    shareId: member.shareId,
                    shareMemberId: member.shareMemberId,
                },
                text: "Visible while model inclusion is off.",
            });
            await transport.postMember({
                clientMessageId: "client-1",
                displayName: "Friend",
                grant: {
                    grantEpoch: member.grantEpoch,
                    murmurPeerId: member.murmurPeerId,
                    shareId: member.shareId,
                    shareMemberId: member.shareMemberId,
                },
                text: "Duplicate delivery",
            });

            expect(delivered).toHaveBeenCalledTimes(1);
            const [sessionId, message, persisted] = delivered.mock.calls[0]!;
            expect(sessionId).toBe("session-1");
            expect(message).toMatchObject({
                contextOnly: true,
                friendAuthor: { murmurPeerId: "peer-friend" },
            });
            expect(persisted).toMatchObject({
                createdAt: 10,
                event: { type: "message_submitted" },
                position: 0,
            });
            expect(querySessionShareFriendMessages(database, { shareId: "share-1" })).toMatchObject(
                [{ disposition: "pending", messageId: message.id }],
            );
            expect(
                database
                    .select()
                    .from(sessions)
                    .all()
                    .map((row) => row.id),
            ).toEqual(["session-1"]);
            restarted.close();
        } finally {
            opened.client.close();
            await rm(directory, { force: true, recursive: true });
        }
    });
});
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
