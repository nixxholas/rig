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
        const homeDirectory = await mkdtemp(join(tmpdir(), "rig-sharing-reset-"));
        directories.push(homeDirectory);
        const database = new PersistentSessionStore({
            databasePath: ":memory:",
            homeDirectory,
        });
        const profiles = new RigProfileStore({
            database,
            localInstanceId: database.localInstanceId,
            publish: () => undefined,
        });
        const profile = profiles.create({ email: "steve@example.test", name: "Steve" });
        const root = database.createFolder({ name: "Shared" });
        database.createFolder({ name: "Child", parentId: root.id });
        database.markFolderShared(root.id, GROUP_ID);
        database.transaction((tx) => {
            sharingProfileBind(tx, profile.id, GROUP_ID, 1);
            folderShareCreate(tx, {
                groupId: GROUP_ID,
                now: 1,
                rootFolderId: root.id,
                sender: GROUP_ID,
                shareId: "01900000-0000-7000-8000-000000000001",
                state: database.sharedFolderState(root.id),
                status: "synced",
            });
        });

        database.resetSharingState();

        expect(database.getFolder(root.id)).toMatchObject({ shared: false, version: 3 });
        expect(database.query(queryFolderShares)).toEqual([]);
        expect(database.query(querySharingProfileBinding)).toEqual({
            murmurIdentity: null,
            profileId: profile.id,
        });
        database.close();
    });
});
