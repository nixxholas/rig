import { createTestRootContext } from "../../testing/createTestRootContext.js";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { folderShareCreate } from "../folderShare/folderShareCreate.js";
import { queryFolderShares } from "../folderShare/queryFolderShares.js";
import { RigProfileStore } from "../../profiles/index.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import { querySharingProfileBinding } from "./querySharingProfileId.js";
import { sharingProfileBind } from "./sharingProfileBind.js";

const GROUP_ID = "A".repeat(43);
const directories: string[] = [];

afterEach(async () => {
    for (const directory of directories.splice(0)) {
        await rm(directory, { force: true, recursive: true });
    }
});

describe("resetting Sharing state", () => {
    it("keeps the selected profile while removing its Murmur identity and folder groups", async () => {
        const ctx = createTestRootContext();
        const homeDirectory = await mkdtemp(join(tmpdir(), "rig-sharing-reset-"));
        directories.push(homeDirectory);
        const database = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
            homeDirectory,
        });
        const profiles = new RigProfileStore({
            database,
            localInstanceId: database.localInstanceId,
            publish: (_ctx, _event) => undefined,
        });
        const profile = await profiles.create(ctx, { email: "steve@example.test", name: "Steve" });
        const root = await database.createFolder(ctx, { name: "Shared" });
        await database.createFolder(ctx, { name: "Child", parentId: root.id });
        await database.markFolderShared(ctx, root.id, GROUP_ID);
        await database.transaction(ctx, async (transactionCtx) => {
            await sharingProfileBind(transactionCtx, profile.id, GROUP_ID, 1);
            await folderShareCreate(transactionCtx, {
                groupId: GROUP_ID,
                now: 1,
                rootFolderId: root.id,
                sender: GROUP_ID,
                shareId: "01900000-0000-7000-8000-000000000001",
                state: await database.sharedFolderState(transactionCtx, root.id),
                status: "synced",
            });
        });

        await database.resetSharingState(ctx);

        expect(await database.getFolder(ctx, root.id)).toMatchObject({ shared: false, version: 3 });
        expect(await database.query(ctx, (queryCtx) => queryFolderShares(queryCtx))).toEqual([]);
        expect(
            await database.query(ctx, (queryCtx) => querySharingProfileBinding(queryCtx)),
        ).toEqual({
            murmurIdentity: null,
            profileId: profile.id,
        });
        await database.close(ctx);
    });
});
