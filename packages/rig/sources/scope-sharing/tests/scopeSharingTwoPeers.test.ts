import { afterEach, describe, expect, it } from "vitest";

import { InMemoryMurmurRelay } from "../../murmur/InMemoryMurmurRelay.js";
import type { MurmurProfile } from "../../protocol/MurmurProtocol.js";
import { sessionEvents } from "../../persistence/database/schema.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import { createShareRuntime } from "../../sharing/createShareRuntime.js";
import {
    createPeer,
    FakeMurmurService,
    friendship,
    pumpUntil,
} from "../../sharing/tests/murmurTwoPeerHarness.js";
import { createScopeShareKind } from "../createScopeShareKind.js";
import type { ScopeShareProjection } from "../projectScopeShareEntry.js";
import type { ScopeShareServiceContract, ScopeShareTarget } from "../ScopeShareServiceContract.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("scope sharing between two peers over the real Murmur transport", () => {
    it("replicates a scope and its sessions, catches a late member up, and ends on revoke", async () => {
        const relay = new InMemoryMurmurRelay();
        const owner = await createPeer(relay);
        const first = await createPeer(relay);
        const second = await createPeer(relay);
        const ownerProfile: MurmurProfile = { firstName: "Dana", lastName: "Owner" };
        const firstProfile: MurmurProfile = { firstName: "Robin", lastName: "First" };
        const secondProfile: MurmurProfile = { firstName: "Sam", lastName: "Second" };

        const ownerMurmur = new FakeMurmurService(owner, ownerProfile, () => [
            friendship(first, firstProfile),
            friendship(second, secondProfile),
        ]);
        const firstMurmur = new FakeMurmurService(first, firstProfile, () => [
            friendship(owner, ownerProfile),
        ]);
        const secondMurmur = new FakeMurmurService(second, secondProfile, () => [
            friendship(owner, ownerProfile),
        ]);
        const peers = [ownerMurmur, firstMurmur, secondMurmur];

        const ownerHost = createHost(ownerMurmur);
        const firstHost = createHost(firstMurmur);
        const secondHost = createHost(secondMurmur);

        // Two chats in the same scope, so the friend's one log has to carry both
        // rather than a single conversation. Neither belongs to a workspace, which
        // is exactly the case a project share must still cover.
        const sessionA = ownerHost.store.create({ cwd: "/tmp/scope-owner" });
        const projectId = sessionA.projectIdentity().projectId;
        const sessionB = ownerHost.store.create({ cwd: "/tmp/scope-owner" });
        const scope: ScopeShareTarget = { scopeId: projectId, scopeKind: "project" };
        say(ownerHost, sessionA.id, "a-1", "Looking at the failing test.");
        say(ownerHost, sessionB.id, "b-1", "Reading the other one.");

        let created!: Awaited<ReturnType<ScopeShareServiceContract["create"]>>;
        await pumpUntil(peers, async () => {
            try {
                created = await ownerHost.runtime.contract.create(scope, {
                    friends: [{ displayName: "Robin", peerId: first.peerId }],
                    mutationId: "mutation-create",
                });
                return created.share.state === "active";
            } catch {
                return false;
            }
        });
        expect(created.share).toMatchObject({
            memberCount: 1,
            scopeId: projectId,
            scopeKind: "project",
            state: "active",
        });
        const shareId = created.share.shareId;

        // The index a member lists is the scope and one entry per session; the
        // transcript rides the same log but is read one session at a time, so a
        // member never has to page a whole workspace to open a single chat.
        await pumpUntil(
            peers,
            () =>
                (firstHost.runtime.contract.replica(shareId)?.entries.length ?? 0) >= 3 &&
                (firstHost.runtime.contract.replicaSessionHistory(shareId, sessionB.id)?.entries
                    .length ?? 0) >= 1,
        );
        const replicated = firstHost.runtime.contract.replica(shareId)!;
        const projections = replicated.entries.map(
            (entry) => JSON.parse(entry.canonicalJson) as ScopeShareProjection,
        );
        expect(projections[0]?.subject).toBe("scope");
        expect(
            projections
                .filter((projection) => projection.subject === "session_index")
                .map((projection) => projection.sessionId)
                .sort(),
        ).toEqual([sessionA.id, sessionB.id].sort());
        const historyA = firstHost.runtime.contract.replicaSessionHistory(shareId, sessionA.id)!;
        expect(historyA.entries).toHaveLength(1);
        expect(historyA.entries[0]!.canonicalJson).toContain("Looking at the failing test.");
        expect(historyA.entries[0]!.canonicalJson).not.toContain("Reading the other one.");
        // Nothing about where the owner keeps any of this travels with it.
        expect(JSON.stringify(projections)).not.toContain("/tmp/scope-owner");
        expect(JSON.stringify(historyA)).not.toContain("/tmp/scope-owner");

        // A member invited later is offered the whole log from the beginning, in order.
        await ownerHost.runtime.contract.add(scope, {
            friend: { displayName: "Sam", peerId: second.peerId },
            mutationId: "mutation-add",
        });
        await pumpUntil(
            peers,
            () =>
                (secondHost.runtime.contract.replica(shareId)?.entries.length ?? 0) >=
                replicated.entries.length,
        );
        const late = secondHost.runtime.contract.replica(shareId)!;
        expect(late.entries.map((entry) => entry.shareSequence)).toEqual(
            replicated.entries.map((entry) => entry.shareSequence),
        );
        expect(late.entries.map((entry) => entry.canonicalJson)).toEqual(
            replicated.entries.map((entry) => entry.canonicalJson),
        );
        // Catching up carries the transcript that predates the member as well.
        expect(
            secondHost.runtime.contract
                .replicaSessionHistory(shareId, sessionA.id)
                ?.entries.map((entry) => entry.canonicalJson),
        ).toEqual(historyA.entries.map((entry) => entry.canonicalJson));

        // Revoking one member retires that replica's rows and leaves the other's alone.
        const member = created.members[0]!;
        await ownerHost.runtime.contract.revoke(scope, member.shareMemberId, {
            mutationId: "mutation-revoke",
        });
        await pumpUntil(
            peers,
            () => firstHost.runtime.contract.replica(shareId)?.replica.state === "ended",
        );
        expect(firstHost.runtime.contract.replica(shareId)?.entries).toEqual([]);
        expect(secondHost.runtime.contract.replica(shareId)?.replica.state).toBe("active");

        // The owner keeps replicating to the member that is still there — both a session
        // that did not exist when the share was created and what is said in it.
        const sessionC = ownerHost.store.create({ cwd: "/tmp/scope-owner" });
        say(ownerHost, sessionC.id, "c-1", "Opened a third chat.");
        await pumpUntil(peers, () => {
            ownerHost.runtime.wakeForSession({ projectId });
            const history = secondHost.runtime.contract.replicaSessionHistory(shareId, sessionC.id);
            return (
                history?.entries.some((entry) =>
                    entry.canonicalJson.includes("Opened a third chat."),
                ) === true
            );
        });
    }, 60_000);
});

/**
 * Put one notice in a session's own event log, which is what a scope share tails.
 *
 * A live session writes these as its agent runs; a test says them directly so the
 * transcript half of the log is exercised without standing an agent up.
 */
function say(
    host: { store: PersistentSessionStore },
    sessionId: string,
    id: string,
    text: string,
): void {
    host.store.transaction((tx) =>
        tx
            .insert(sessionEvents)
            .values({
                createdAtMs: 10,
                dataJson: JSON.stringify({
                    message: {
                        blocks: [{ text, type: "text" }],
                        id: `${sessionId}-${id}-message`,
                        role: "system",
                    },
                }),
                eventId: `${sessionId}-${id}`,
                sessionId,
                type: "system_notice",
            })
            .run(),
    );
}

function createHost(murmur: FakeMurmurService): {
    runtime: ReturnType<typeof createScopeSharingRuntime>;
    store: PersistentSessionStore;
} {
    const store = new PersistentSessionStore({ databasePath: ":memory:" });
    const runtime = createScopeSharingRuntime({
        daemonStore: store.scopeShareDaemonStore,
        murmur,
        shareStore: store.scopeShares,
    });
    cleanups.push(() => store.close());
    cleanups.push(() => void runtime.close());
    return { runtime, store };
}

/**
 * Scope sharing over the one shared runtime, which is what the daemon builds.
 *
 * Every kind of share rides a single transport, directory, and event router, so a
 * test that wants only the scope kind still goes through the same assembly.
 */
function createScopeSharingRuntime(options: {
    daemonStore: PersistentSessionStore["scopeShareDaemonStore"];
    murmur: FakeMurmurService;
    shareStore: PersistentSessionStore["scopeShares"];
}): {
    close: () => Promise<void>;
    contract: ScopeShareServiceContract;
    wakeForSession: (scope: { projectId: string; workspaceId?: string }) => void;
} {
    const runtime = createShareRuntime({
        kinds: {
            scope: createScopeShareKind({
                daemonStore: options.daemonStore,
                shareStore: options.shareStore,
            }),
        },
        murmur: options.murmur,
    });
    return {
        close: runtime.close,
        contract: runtime.kinds.scope.contract,
        wakeForSession: runtime.kinds.scope.wakeForSession,
    };
}
