import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CreateMurmurSessionOptions, MurmurSession } from "@slopus/murmur";
import { afterEach, describe, expect, it } from "vitest";

import { PersistentSessionStore } from "../session/PersistentSessionStore.js";
import {
    FOLDER_SHARING_MURMUR_SERVICE_ID,
    FolderSharingService,
    type FolderSharingMurmurClient,
} from "./FolderSharingService.js";

const ALICE = new Uint8Array(32).fill(1);
const BOB = new Uint8Array(32).fill(2);
const GROUP = new Uint8Array(32).fill(3);
const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("FolderSharingService", () => {
    it("bootstraps a Murmur group with current state and synchronizes later tree changes", async () => {
        const aliceStore = store();
        const aliceClient = new FakeFolderMurmurClient(ALICE);
        const alice = service(aliceStore);
        alice.attach(aliceClient);
        const root = aliceStore.createFolder({ name: "Shared" });
        const first = aliceStore.createFolder({ name: "First", parentId: root.id });

        const status = await alice.create(root.id, [encode(BOB)]);

        expect(status).toMatchObject({
            groupId: encode(GROUP),
            rootFolderId: root.id,
            status: "syncing",
        });
        expect(aliceStore.getFolder(root.id)?.shared).toBe(true);
        expect(aliceClient.created?.service).toBe(FOLDER_SHARING_MURMUR_SERVICE_ID);
        const descriptor = JSON.parse(
            new TextDecoder().decode(aliceClient.created?.descriptor),
        ) as Record<string, unknown>;
        expect(descriptor).toMatchObject({
            kind: "folder_share",
            state: {
                folders: [
                    { id: root.id, name: "Shared", order: 0 },
                    { id: first.id, name: "First", order: 0, parentId: root.id },
                ],
                rootId: root.id,
            },
            version: 1,
        });
        expect(JSON.stringify(descriptor)).not.toContain(root.path);
        await alice.onUpdate({
            bytes: aliceClient.sent[0]!.bytes,
            id: "creator-bootstrap-echo",
            sender: ALICE,
            sessionId: GROUP,
        });
        await expect(alice.statuses()).resolves.toEqual([
            expect.objectContaining({ status: "synced" }),
        ]);

        const bobStore = store();
        const bob = service(bobStore);
        bob.attach(new FakeFolderMurmurClient(BOB));
        await expect(
            bob.onNewSession({
                committer: ALICE,
                descriptor: aliceClient.created!.descriptor,
                id: GROUP,
                members: [ALICE, BOB],
            }),
        ).resolves.toBe(true);
        expect(bobStore.getFolder(root.id)?.shared).toBe(true);
        expect(bobStore.getFolder(first.id)?.parentId).toBe(root.id);
        await bob.onUpdate({
            bytes: aliceClient.sent[0]!.bytes,
            id: "delivery-bootstrap",
            sender: ALICE,
            sessionId: GROUP,
        });

        const second = aliceStore.createFolder({ name: "Second" });
        aliceStore.moveFolder(second.id, { afterId: first.id, parentId: root.id }, second.version);
        alice.foldersChanged();
        await alice.drain();

        expect(aliceClient.sent).toHaveLength(2);
        await bob.onUpdate({
            bytes: aliceClient.sent[1]!.bytes,
            id: "delivery-1",
            sender: ALICE,
            sessionId: GROUP,
        });
        expect(
            bobStore
                .listFolders()
                .filter((folder) => folder.parentId === root.id && folder.archivedAt === undefined)
                .map((folder) => folder.name),
        ).toEqual(["First", "Second"]);

        const currentSecond = aliceStore.getFolder(second.id)!;
        aliceStore.moveFolder(
            second.id,
            { afterId: null, parentId: root.id },
            currentSecond.version,
        );
        alice.foldersChanged();
        await alice.drain();

        expect(aliceClient.sent).toHaveLength(3);
        await bob.onUpdate({
            bytes: aliceClient.sent[2]!.bytes,
            id: "delivery-2",
            sender: ALICE,
            sessionId: GROUP,
        });
        expect(
            bobStore
                .listFolders()
                .filter((folder) => folder.parentId === root.id && folder.archivedAt === undefined)
                .map((folder) => folder.name),
        ).toEqual(["Second", "First"]);

        const currentFirst = aliceStore.getFolder(first.id)!;
        aliceStore.moveFolder(first.id, { afterId: null, parentId: null }, currentFirst.version);
        alice.foldersChanged();
        await alice.drain();

        expect(aliceClient.sent).toHaveLength(4);
        const removalUpdate = {
            bytes: aliceClient.sent[3]!.bytes,
            id: "delivery-3",
            sender: ALICE,
            sessionId: GROUP,
        };
        await bob.onUpdate(removalUpdate);
        await bob.onUpdate(removalUpdate);
        expect(bobStore.getFolder(first.id)?.archivedAt).toBeDefined();
        expect(
            bobStore
                .listFolders()
                .filter((folder) => folder.parentId === root.id && folder.archivedAt === undefined)
                .map((folder) => folder.name),
        ).toEqual(["Second"]);

        const detachedFirst = aliceStore.getFolder(first.id)!;
        aliceStore.moveFolder(
            first.id,
            { afterId: second.id, parentId: root.id },
            detachedFirst.version,
        );
        alice.foldersChanged();
        await alice.drain();

        expect(aliceClient.sent).toHaveLength(5);
        await bob.onUpdate({
            bytes: aliceClient.sent[4]!.bytes,
            id: "delivery-4",
            sender: ALICE,
            sessionId: GROUP,
        });
        expect(bobStore.getFolder(first.id)?.archivedAt).toBeUndefined();
        expect(
            bobStore
                .listFolders()
                .filter((folder) => folder.parentId === root.id && folder.archivedAt === undefined)
                .map((folder) => folder.name),
        ).toEqual(["Second", "First"]);

        aliceStore.close();
        bobStore.close();
    });

    it("merges concurrent additions from different Murmur members", async () => {
        const aliceStore = store();
        const aliceClient = new FakeFolderMurmurClient(ALICE);
        const alice = service(aliceStore);
        alice.attach(aliceClient);
        const root = aliceStore.createFolder({ name: "Shared" });
        await alice.create(root.id, [encode(BOB)]);

        const bobStore = store();
        const bobClient = new FakeFolderMurmurClient(BOB);
        const bob = service(bobStore);
        bob.attach(bobClient);
        await bob.onNewSession({
            committer: ALICE,
            descriptor: aliceClient.created!.descriptor,
            id: GROUP,
            members: [ALICE, BOB],
        });

        aliceStore.createFolder({ name: "From Alice", parentId: root.id });
        bobStore.createFolder({ name: "From Bob", parentId: root.id });
        alice.foldersChanged();
        bob.foldersChanged();
        await Promise.all([alice.drain(), bob.drain()]);

        await bob.onUpdate({
            bytes: aliceClient.sent[1]!.bytes,
            id: "alice-concurrent",
            sender: ALICE,
            sessionId: GROUP,
        });
        await alice.onUpdate({
            bytes: bobClient.sent[0]!.bytes,
            id: "bob-concurrent",
            sender: BOB,
            sessionId: GROUP,
        });

        const names = (target: PersistentSessionStore) =>
            target
                .listFolders()
                .filter((folder) => folder.parentId === root.id && folder.archivedAt === undefined)
                .map((folder) => folder.name)
                .sort();
        expect(names(aliceStore)).toEqual(["From Alice", "From Bob"]);
        expect(names(bobStore)).toEqual(["From Alice", "From Bob"]);

        aliceStore.close();
        bobStore.close();
    });

    it("consumes an invalid authenticated operation without blocking later updates", async () => {
        const aliceStore = store();
        const aliceClient = new FakeFolderMurmurClient(ALICE);
        const alice = service(aliceStore);
        alice.attach(aliceClient);
        const root = aliceStore.createFolder({ name: "Shared" });
        await alice.create(root.id, [encode(BOB)]);

        const bobStore = store();
        const bob = service(bobStore);
        bob.attach(new FakeFolderMurmurClient(BOB));
        await bob.onNewSession({
            committer: ALICE,
            descriptor: aliceClient.created!.descriptor,
            id: GROUP,
            members: [ALICE, BOB],
        });
        await bob.onUpdate({
            bytes: aliceClient.sent[0]!.bytes,
            id: "bootstrap-delivery",
            sender: ALICE,
            sessionId: GROUP,
        });
        const duplicateRoot = { id: root.id, name: "Shared", order: 0 };
        await expect(
            bob.onUpdate({
                bytes: new TextEncoder().encode(
                    JSON.stringify({
                        clock: Number.MAX_SAFE_INTEGER,
                        operationId: "clock-jump",
                        operations: [{ node: duplicateRoot, type: "upsert" }],
                        type: "operations",
                        version: 1,
                    }),
                ),
                id: "clock-jump-delivery",
                sender: ALICE,
                sessionId: GROUP,
            }),
        ).resolves.toBeUndefined();
        await expect(
            bob.onUpdate({
                bytes: new TextEncoder().encode(
                    JSON.stringify({
                        clock: 2,
                        operationId: "malformed-operation",
                        operations: [
                            { node: duplicateRoot, type: "upsert" },
                            { node: duplicateRoot, type: "upsert" },
                        ],
                        type: "operations",
                        version: 1,
                    }),
                ),
                id: "malformed-delivery",
                sender: ALICE,
                sessionId: GROUP,
            }),
        ).resolves.toBeUndefined();

        aliceStore.createFolder({ name: "Valid", parentId: root.id });
        alice.foldersChanged();
        await alice.drain();
        await bob.onUpdate({
            bytes: aliceClient.sent[1]!.bytes,
            id: "valid-delivery",
            sender: ALICE,
            sessionId: GROUP,
        });
        expect(
            bobStore
                .listFolders()
                .some((folder) => folder.name === "Valid" && folder.archivedAt === undefined),
        ).toBe(true);

        aliceStore.close();
        bobStore.close();
    });

    it("recovers a creator session persisted before the Rig mapping", async () => {
        const targetStore = store();
        const client = new FakeFolderMurmurClient(ALICE);
        client.throwAfterCreate = true;
        const interrupted = service(targetStore);
        interrupted.attach(client);
        const root = targetStore.createFolder({ name: "Shared" });

        await expect(interrupted.create(root.id, [encode(BOB)])).rejects.toThrow(
            "simulated interruption",
        );
        expect(targetStore.getFolder(root.id)?.shared).toBe(false);

        client.throwAfterCreate = false;
        const recovered = service(targetStore);
        recovered.attach(client);
        await recovered.recover();

        expect(targetStore.getFolder(root.id)?.shared).toBe(true);
        await expect(recovered.statuses()).resolves.toEqual([
            expect.objectContaining({
                groupId: encode(GROUP),
                rootFolderId: root.id,
            }),
        ]);
        targetStore.close();
    });

    it("recovers the same creation intent before an immediate retry", async () => {
        const targetStore = store();
        const client = new FakeFolderMurmurClient(ALICE);
        client.throwAfterCreate = true;
        const target = service(targetStore);
        target.attach(client);
        const root = targetStore.createFolder({ name: "Shared" });

        await expect(target.create(root.id, [encode(BOB)])).rejects.toThrow(
            "simulated interruption",
        );
        client.throwAfterCreate = false;
        await expect(target.create(root.id, [encode(BOB)])).resolves.toMatchObject({
            groupId: encode(GROUP),
            rootFolderId: root.id,
        });

        expect(client.createCalls).toBe(1);
        targetStore.close();
    });

    it("keeps concurrent parent cycles reachable with a deterministic root break", async () => {
        const aliceStore = store();
        const aliceClient = new FakeFolderMurmurClient(ALICE);
        const alice = service(aliceStore);
        alice.attach(aliceClient);
        const root = aliceStore.createFolder({ name: "Shared" });
        const first = aliceStore.createFolder({ name: "First", parentId: root.id });
        const second = aliceStore.createFolder({ name: "Second", parentId: root.id });
        await alice.create(root.id, [encode(BOB)]);

        const bobStore = store();
        const bob = service(bobStore);
        bob.attach(new FakeFolderMurmurClient(BOB));
        await bob.onNewSession({
            committer: ALICE,
            descriptor: aliceClient.created!.descriptor,
            id: GROUP,
            members: [ALICE, BOB],
        });
        await bob.onUpdate({
            bytes: aliceClient.sent[0]!.bytes,
            id: "cycle-bootstrap",
            sender: ALICE,
            sessionId: GROUP,
        });

        const packet = (operationId: string, node: Record<string, unknown>) =>
            new TextEncoder().encode(
                JSON.stringify({
                    clock: 2,
                    operationId,
                    operations: [{ node, type: "upsert" }],
                    type: "operations",
                    version: 1,
                }),
            );
        await bob.onUpdate({
            bytes: packet("move-first", {
                id: first.id,
                name: "First",
                order: 0,
                parentId: second.id,
            }),
            id: "move-first-delivery",
            sender: ALICE,
            sessionId: GROUP,
        });
        await bob.onUpdate({
            bytes: packet("move-second", {
                id: second.id,
                name: "Second",
                order: 0,
                parentId: first.id,
            }),
            id: "move-second-delivery",
            sender: BOB,
            sessionId: GROUP,
        });

        const active = bobStore
            .listFolders()
            .filter(
                (folder) =>
                    (folder.id === first.id || folder.id === second.id) &&
                    folder.archivedAt === undefined,
            );
        expect(active).toHaveLength(2);
        expect(active.some((folder) => folder.parentId === root.id)).toBe(true);

        aliceStore.close();
        bobStore.close();
    });
});

class FakeFolderMurmurClient implements FolderSharingMurmurClient {
    created: CreateMurmurSessionOptions | undefined;
    createCalls = 0;
    readonly sent: { bytes: Uint8Array; id: Uint8Array }[] = [];
    throwAfterCreate = false;

    constructor(readonly identity: Uint8Array) {}

    async createSession(options: CreateMurmurSessionOptions): Promise<MurmurSession> {
        this.createCalls += 1;
        this.created = options;
        if (this.throwAfterCreate) throw new Error("simulated interruption");
        return session(options.descriptor, this.identity);
    }

    async send(id: Uint8Array, bytes: Uint8Array): Promise<string> {
        this.sent.push({ bytes, id });
        return `delivery-${String(this.sent.length)}`;
    }

    async session(_id: Uint8Array): Promise<MurmurSession> {
        return session(this.created?.descriptor ?? new Uint8Array(), this.identity);
    }

    async sessions(): Promise<{ cursor: null; sessions: MurmurSession[] }> {
        return {
            cursor: null,
            sessions:
                this.created === undefined ? [] : [session(this.created.descriptor, this.identity)],
        };
    }
}

function service(store: PersistentSessionStore): FolderSharingService {
    return new FolderSharingService({
        database: store,
        folders: store,
        onChanged: () => undefined,
    });
}

function store(): PersistentSessionStore {
    const homeDirectory = mkdtempSync(join(tmpdir(), "rig-folder-sharing-"));
    directories.push(homeDirectory);
    return new PersistentSessionStore({
        databasePath: ":memory:",
        homeDirectory,
    });
}

function session(descriptor: Uint8Array, self: Uint8Array): MurmurSession {
    return {
        bufferedEvents: 0,
        committer: ALICE,
        descriptor,
        id: GROUP,
        members: [self, self === ALICE ? BOB : ALICE],
        status: "active",
    };
}

function encode(value: Uint8Array): string {
    return Buffer.from(value).toString("base64url");
}
