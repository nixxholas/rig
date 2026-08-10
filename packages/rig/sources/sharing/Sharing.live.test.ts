import { createTestRootContext } from "../testing/createTestRootContext.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RigProfileStore } from "../profiles/index.js";
import { SqliteMurmurStore } from "../persistence/sharing/index.js";
import { PersistentSessionStore } from "../session/PersistentSessionStore.js";
import { SharingService } from "./SharingService.js";

const LIVE = process.env.RIG_LIVE_TEST === "1";
const describeLive = LIVE ? describe : describe.skip;
const cleanups: Array<() => Promise<void>> = [];
const WAIT = { interval: 200, timeout: 90_000 } as const;
const ctx = createTestRootContext().named("sharing-live-test");

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describeLive("Sharing through the live Murmur relay", () => {
    it(
        "synchronizes one folder tree bidirectionally between two real Rigs",
        { timeout: 120_000 },
        async () => {
            const alice = await LiveRig.create("Alice");
            const bob = await LiveRig.create("Bob");
            await makeContacts(alice, bob);

            const root = await alice.folders.createFolder(ctx, { name: "Shared campaign" });
            const child = await alice.folders.createFolder(ctx, {
                name: "Drafts",
                parentId: root.id,
            });
            const bobIdentity = (await bob.sharing.snapshot(ctx)).identity;
            await alice.sharing.createFolderShare(ctx, root.id, [bobIdentity]);
            await alice.folders.updateFolder(
                ctx,
                child.id,
                { name: "Ready for review" },
                child.version,
            );

            await vi.waitFor(async () => {
                expect(await bob.folders.getFolder(ctx, root.id)).toMatchObject({
                    name: "Shared campaign",
                    shared: true,
                });
                expect(await bob.folders.getFolder(ctx, child.id)).toMatchObject({
                    name: "Ready for review",
                    parentId: root.id,
                });
            }, WAIT);

            const bobChild = await bob.folders.getFolder(ctx, child.id);
            expect(bobChild).toBeDefined();
            await bob.folders.updateFolder(
                ctx,
                child.id,
                { description: "Approved on Bob's Rig" },
                bobChild!.version,
            );
            await vi.waitFor(async () => {
                expect((await alice.folders.getFolder(ctx, child.id))?.description).toBe(
                    "Approved on Bob's Rig",
                );
            }, WAIT);
        },
    );

    it(
        "completes a contact handshake while each side is alternately offline",
        { timeout: 150_000 },
        async () => {
            const alice = await LiveRig.create("Alice");
            const bob = await LiveRig.create("Bob");
            await waitConnected(alice, bob);

            const invitation = await alice.sharing.createInvitation(ctx);
            await alice.stop();
            await bob.sharing.requestContact(ctx, invitation.invitation);
            await bob.stop();
            await bob.start();
            await waitOutboundFlushed(bob);
            await bob.stop();

            await alice.start();
            const requestId = await waitForRequest(alice);
            await alice.sharing.acceptContact(ctx, requestId);
            await alice.stop();
            await alice.start();
            await waitOutboundFlushed(alice);
            await alice.stop();

            await bob.start();
            await vi.waitFor(async () => {
                expect((await bob.sharing.snapshot(ctx)).contacts).toHaveLength(1);
            }, WAIT);
            await bob.stop();

            await alice.start();
            await vi.waitFor(async () => {
                expect((await alice.sharing.snapshot(ctx)).contacts).toHaveLength(1);
            }, WAIT);
        },
    );

    it(
        "delivers folder creation and reverse edits after their senders go offline",
        { timeout: 180_000 },
        async () => {
            const alice = await LiveRig.create("Alice");
            const bob = await LiveRig.create("Bob");
            await makeContacts(alice, bob);
            const root = await alice.folders.createFolder(ctx, { name: "Offline campaign" });
            const child = await alice.folders.createFolder(ctx, {
                name: "Draft",
                parentId: root.id,
            });
            const bobIdentity = (await bob.sharing.snapshot(ctx)).identity;

            await bob.stop();
            await alice.sharing.createFolderShare(ctx, root.id, [bobIdentity]);
            await alice.folders.updateFolder(
                ctx,
                child.id,
                { name: "Queued by Alice" },
                child.version,
            );
            await publishThenStop(alice);

            await bob.start();
            await vi.waitFor(async () => {
                expect(await bob.folders.getFolder(ctx, root.id)).toMatchObject({
                    name: "Offline campaign",
                    shared: true,
                });
                expect((await bob.folders.getFolder(ctx, child.id))?.name).toBe("Queued by Alice");
            }, WAIT);
            const bobChild = (await bob.folders.getFolder(ctx, child.id))!;
            await bob.folders.updateFolder(
                ctx,
                child.id,
                { description: "Queued by Bob" },
                bobChild.version,
            );
            await publishThenStop(bob);

            await alice.start();
            await vi.waitFor(async () => {
                expect((await alice.folders.getFolder(ctx, child.id))?.description).toBe(
                    "Queued by Bob",
                );
            }, WAIT);
        },
    );

    it(
        "converges after many seeded reorders across alternating offline Rigs",
        { timeout: 300_000 },
        async () => {
            const alice = await LiveRig.create("Alice");
            const bob = await LiveRig.create("Bob");
            await makeContacts(alice, bob);
            const root = await alice.folders.createFolder(ctx, { name: "Chaos board" });
            for (let index = 0; index < 8; index += 1) {
                await alice.folders.createFolder(ctx, {
                    name: `Lane ${index + 1}`,
                    parentId: root.id,
                });
            }
            const bobIdentity = (await bob.sharing.snapshot(ctx)).identity;
            await alice.sharing.createFolderShare(ctx, root.id, [bobIdentity]);
            await vi.waitFor(async () => {
                expect(await directChildren(bob, root.id)).toEqual(
                    await directChildren(alice, root.id),
                );
            }, WAIT);

            const random = seededRandom(0x5eedc0de);
            let writer = alice;
            let reader = bob;
            for (let round = 0; round < 6; round += 1) {
                await reader.stop();
                for (let operation = 0; operation < 16; operation += 1) {
                    await reorderOne(writer, root.id, random);
                }
                const expected = await directChildren(writer, root.id);
                await publishThenStop(writer);
                await reader.start();
                await vi.waitFor(async () => {
                    expect(await directChildren(reader, root.id)).toEqual(expected);
                }, WAIT);
                [writer, reader] = [reader, writer];
            }
        },
    );
});

async function makeContacts(inviter: LiveRig, requester: LiveRig): Promise<void> {
    await waitConnected(inviter, requester);
    const invitation = await inviter.sharing.createInvitation(ctx);
    await requester.sharing.requestContact(ctx, invitation.invitation);
    await inviter.sharing.acceptContact(ctx, await waitForRequest(inviter));
    await vi.waitFor(async () => {
        expect((await inviter.sharing.snapshot(ctx)).contacts).toHaveLength(1);
        expect((await requester.sharing.snapshot(ctx)).contacts).toHaveLength(1);
    }, WAIT);
}

async function waitForRequest(rig: LiveRig): Promise<string> {
    let requestId = "";
    await vi.waitFor(async () => {
        const [request] = (await rig.sharing.snapshot(ctx)).incomingRequests;
        expect(request).toBeDefined();
        requestId = request!.id;
    }, WAIT);
    return requestId;
}

async function waitConnected(...rigs: LiveRig[]): Promise<void> {
    await vi.waitFor(async () => {
        for (const rig of rigs) {
            expect(
                (await rig.sharing.snapshot(ctx)).connection,
                `${rig.name}: ${rig.errors.join("; ")}`,
            ).toBe("connected");
        }
    }, WAIT);
}

async function waitOutboundFlushed(rig: LiveRig): Promise<void> {
    await vi.waitFor(async () => {
        expect(await rig.hasPendingMurmurOutboxes()).toBe(false);
    }, WAIT);
}

async function publishThenStop(rig: LiveRig): Promise<void> {
    await rig.stop();
    await rig.start();
    await waitOutboundFlushed(rig);
    await rig.stop();
}

async function directChildren(rig: LiveRig, rootFolderId: string): Promise<string[]> {
    return (await rig.folders.listFolders(ctx))
        .filter((folder) => folder.parentId === rootFolderId && folder.archivedAt === undefined)
        .map((folder) => folder.id);
}

async function reorderOne(rig: LiveRig, rootFolderId: string, random: () => number): Promise<void> {
    const children = await directChildren(rig, rootFolderId);
    const movedId = children[Math.floor(random() * children.length)]!;
    const remaining = children.filter((id) => id !== movedId);
    const position = Math.floor(random() * (remaining.length + 1));
    const afterId = position === 0 ? null : remaining[position - 1]!;
    const moved = (await rig.folders.getFolder(ctx, movedId))!;
    await rig.folders.moveFolder(ctx, movedId, { afterId, parentId: rootFolderId }, moved.version);
}

function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return state / 0x1_0000_0000;
    };
}

class LiveRig {
    readonly #directory: string;
    readonly #errors: string[] = [];
    readonly #localInstanceId = createId();
    readonly #name: string;
    #database: PersistentSessionStore | undefined;
    #initialized = false;
    #sharing: SharingService | undefined;
    #unsubscribe: (() => void) | undefined;

    private constructor(name: string, directory: string) {
        this.#directory = directory;
        this.#name = name;
    }

    static async create(name: string): Promise<LiveRig> {
        const directory = await mkdtemp(join(tmpdir(), `rig-live-murmur-${name.toLowerCase()}-`));
        const rig = new LiveRig(name, directory);
        cleanups.push(() => rig.destroy());
        await rig.start();
        return rig;
    }

    get folders(): PersistentSessionStore {
        if (this.#database === undefined) throw new Error(`${this.#name} is offline.`);
        return this.#database;
    }

    get errors(): readonly string[] {
        return this.#errors;
    }

    get name(): string {
        return this.#name;
    }

    get sharing(): SharingService {
        if (this.#sharing === undefined) throw new Error(`${this.#name} is offline.`);
        return this.#sharing;
    }

    async hasPendingMurmurOutboxes(): Promise<boolean> {
        const store = new SqliteMurmurStore(join(this.#directory, "sharing-murmur.sqlite"));
        try {
            return (
                (
                    await store.scan("murmur/session-outbox/", {
                        limit: 1,
                    })
                ).size > 0
            );
        } finally {
            await store.close();
        }
    }

    async start(): Promise<void> {
        if (this.#sharing !== undefined) return;
        const database = await PersistentSessionStore.open(ctx, {
            databasePath: join(this.#directory, "rig.sqlite"),
            localInstanceId: this.#localInstanceId,
        });
        const profiles = new RigProfileStore({
            database,
            localInstanceId: database.localInstanceId,
            publish: () => undefined,
        });
        const sharing = await SharingService.open(ctx, {
            database,
            directory: this.#directory,
            folders: database,
            onError: (error) => {
                this.#errors.push(error instanceof Error ? error.message : String(error));
            },
            profiles,
            publish: () => undefined,
        });
        this.#database = database;
        this.#sharing = sharing;
        this.#unsubscribe = database.liveEvents.subscribe(({ event }) => {
            if (event.type === "folders_changed") sharing.foldersChanged(ctx);
        });
        if (!this.#initialized) {
            const profile = await profiles.create(ctx, {
                email: `${this.#name.toLowerCase()}@example.test`,
                name: this.#name,
            });
            await sharing.bindProfile(ctx, profile.id);
            this.#initialized = true;
        }
        sharing.start(ctx);
    }

    async stop(): Promise<void> {
        const sharing = this.#sharing;
        const database = this.#database;
        this.#sharing = undefined;
        this.#database = undefined;
        this.#unsubscribe?.();
        this.#unsubscribe = undefined;
        await sharing?.close(ctx);
        await database?.close(ctx);
    }

    async destroy(): Promise<void> {
        await this.stop();
        await rm(this.#directory, { force: true, recursive: true });
    }
}
