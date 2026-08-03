import { describe, expect, it } from "vitest";

import type {
    ScopeShareReplicaEndedReason,
    ScopeShareScopeKind,
} from "../../persistence/scope-sharing/types.js";
import { FakeShareTransport } from "../../sharing/FakeShareTransport.js";
import { shareKindOf } from "../../sharing/shareId.js";
import type { ShareOpaqueEntry, ShareTransportGrant } from "../../sharing/ShareTransport.js";
import {
    ScopeShareService,
    type ScopeShareCoreStore,
    type ScopeShareFriendInput,
    type ScopeShareMemberRecord,
    type ScopeShareRecord,
    type ScopeShareReplicaRecord,
} from "../ScopeShareService.js";

describe("ScopeShareService", () => {
    it("names a workspace share so its own identifier says what it covers", async () => {
        const { service } = createService();

        const share = await service.create({
            friends: [{ displayName: "Casey", murmurPeerId: "peer-casey" }],
            ownerPeerId: "peer-owner",
            scopeId: "workspace-1",
            scopeKind: "workspace",
        });

        // The kind is authenticated, because the share id is signed into every
        // invitation and bound into every frame.
        expect(shareKindOf(share.shareId)).toBe("workspace");
        expect(share.members).toHaveLength(1);
    });

    it("persists the share before inviting anyone to it", async () => {
        const { service, store } = createService();

        await service.create({
            friends: [
                { displayName: "Casey", murmurPeerId: "peer-casey" },
                { displayName: "Riley", murmurPeerId: "peer-riley" },
            ],
            ownerPeerId: "peer-owner",
            scopeId: "workspace-1",
            scopeKind: "workspace",
        });

        expect(store.operations[0]).toMatch(/^create:wsp_/u);
        expect(store.operations[1]).toMatch(/^health:wsp_.*:active$/u);
    });

    it("records a stop the transport refuses so recovery can replay it", async () => {
        const { service, store, transport } = createService();
        const share = await service.create({
            friends: [{ displayName: "Casey", murmurPeerId: "peer-casey" }],
            ownerPeerId: "peer-owner",
            scopeId: "workspace-1",
            scopeKind: "workspace",
        });
        transport.failNext("stop");

        await expect(service.stop(share.shareId)).rejects.toThrow();

        // The durable stop is the decision; the transport call is how it is carried
        // out, so a share Rig believes is over is never left running.
        expect(store.shares.get(share.shareId)?.state).toBe("stopped");
    });

    it("stops every workspace share beneath an archived project before the project's own", async () => {
        const { service, store } = createService();
        const workspace = await service.create({
            friends: [{ displayName: "Casey", murmurPeerId: "peer-casey" }],
            ownerPeerId: "peer-owner",
            scopeId: "workspace-1",
            scopeKind: "workspace",
        });
        const project = await service.create({
            friends: [{ displayName: "Casey", murmurPeerId: "peer-casey" }],
            ownerPeerId: "peer-owner",
            scopeId: "project-1",
            scopeKind: "project",
        });

        const stopped = await service.stopForArchivedProject("project-1");

        expect(stopped.map((share) => share.shareId)).toEqual([workspace.shareId, project.shareId]);
        expect(store.shares.get(workspace.shareId)?.state).toBe("stopped");
        expect(store.shares.get(project.shareId)?.state).toBe("stopped");
    });

    it("leaves an unrelated share alone when archiving one workspace", async () => {
        const { service, store } = createService();
        const first = await service.create({
            friends: [{ displayName: "Casey", murmurPeerId: "peer-casey" }],
            ownerPeerId: "peer-owner",
            scopeId: "workspace-1",
            scopeKind: "workspace",
        });
        const second = await service.create({
            friends: [{ displayName: "Casey", murmurPeerId: "peer-casey" }],
            ownerPeerId: "peer-owner",
            scopeId: "workspace-2",
            scopeKind: "workspace",
        });

        await service.stopForArchivedWorkspace("workspace-1");

        expect(store.shares.get(first.shareId)?.state).toBe("stopped");
        expect(store.shares.get(second.shareId)?.state).toBe("active");
    });
});

function createService(): {
    service: ScopeShareService;
    store: MemoryScopeShareStore;
    transport: FakeShareTransport;
} {
    const transport = new FakeShareTransport();
    const store = new MemoryScopeShareStore();
    return {
        service: new ScopeShareService({ store, transport }),
        store,
        transport,
    };
}

interface StoredShare {
    members: ScopeShareMemberRecord[];
    ownerPeerId: string;
    projectId: string;
    scopeId: string;
    scopeKind: ScopeShareScopeKind;
    shareId: string;
    state: ScopeShareRecord["state"];
}

class MemoryScopeShareStore implements ScopeShareCoreStore {
    readonly operations: string[] = [];
    readonly shares = new Map<string, StoredShare>();
    #nextMember = 0;

    createShare(input: {
        friends: readonly ScopeShareFriendInput[];
        ownerPeerId: string;
        scopeId: string;
        scopeKind: ScopeShareScopeKind;
        shareId: string;
    }): ScopeShareRecord {
        this.operations.push(`create:${input.shareId}`);
        this.shares.set(input.shareId, {
            members: input.friends.map((friend) => {
                this.#nextMember += 1;
                return {
                    displayName: friend.displayName,
                    grantEpoch: 1,
                    murmurPeerId: friend.murmurPeerId,
                    shareId: input.shareId,
                    shareMemberId: `member-${String(this.#nextMember)}`,
                    state: "active" as const,
                };
            }),
            ownerPeerId: input.ownerPeerId,
            // A workspace share hangs off the project it lives in; a project share is
            // its own project.
            projectId: input.scopeKind === "project" ? input.scopeId : "project-1",
            scopeId: input.scopeId,
            scopeKind: input.scopeKind,
            shareId: input.shareId,
            state: "active",
        });
        return this.queryShare(input.shareId)!;
    }

    queryShare(shareId: string): ScopeShareRecord | undefined {
        const share = this.shares.get(shareId);
        return share === undefined
            ? undefined
            : {
                  members: [...share.members],
                  ownerPeerId: share.ownerPeerId,
                  scopeId: share.scopeId,
                  scopeKind: share.scopeKind,
                  shareId: share.shareId,
                  state: share.state,
              };
    }

    queryActiveShareForScope(scope: {
        scopeId: string;
        scopeKind: ScopeShareScopeKind;
    }): ScopeShareRecord | undefined {
        for (const share of this.shares.values()) {
            if (
                share.scopeId === scope.scopeId &&
                share.scopeKind === scope.scopeKind &&
                share.state !== "stopped"
            ) {
                return this.queryShare(share.shareId);
            }
        }
        return undefined;
    }

    queryRecoverableShares(): readonly ScopeShareRecord[] {
        return [...this.shares.keys()].map((shareId) => this.queryShare(shareId)!);
    }

    queryLiveSharesInProject(projectId: string): readonly ScopeShareRecord[] {
        return [...this.shares.values()]
            .filter((share) => share.projectId === projectId && share.state !== "stopped")
            .sort(
                (left, right) =>
                    Number(left.scopeKind === "project") - Number(right.scopeKind === "project"),
            )
            .map((share) => this.queryShare(share.shareId)!);
    }

    queryEndedGrants(): readonly ShareTransportGrant[] {
        return [];
    }

    addMember(input: {
        displayName: string;
        murmurPeerId: string;
        shareId: string;
        shareMemberId: string;
    }): ScopeShareMemberRecord {
        const share = this.shares.get(input.shareId);
        if (share === undefined) throw new Error("No such share.");
        const member = {
            displayName: input.displayName,
            grantEpoch: 1,
            murmurPeerId: input.murmurPeerId,
            shareId: input.shareId,
            shareMemberId: input.shareMemberId,
            state: "active" as const,
        };
        share.members.push(member);
        return member;
    }

    revokeMember(shareId: string, shareMemberId: string): ScopeShareMemberRecord {
        const share = this.shares.get(shareId);
        const index = share?.members.findIndex((member) => member.shareMemberId === shareMemberId);
        if (share === undefined || index === undefined || index < 0) {
            throw new Error("No such member.");
        }
        const revoked = { ...share.members[index]!, state: "revoked" as const };
        share.members[index] = revoked;
        return revoked;
    }

    stopShare(shareId: string): ScopeShareRecord {
        const share = this.shares.get(shareId);
        if (share === undefined) throw new Error("No such share.");
        share.state = "stopped";
        this.operations.push(`stop:${shareId}`);
        return this.queryShare(shareId)!;
    }

    setShareHealth(shareId: string, state: "active" | "degraded"): void {
        this.operations.push(`health:${shareId}:${state}`);
        const share = this.shares.get(shareId);
        if (share !== undefined && share.state !== "stopped") share.state = state;
    }

    tailOutbox(): number {
        return 0;
    }

    queryOutboxPage(): readonly ShareOpaqueEntry[] {
        return [];
    }

    acknowledgeOutbox(): void {}

    saveReplica(_replica: ScopeShareReplicaRecord): void {}

    appendReplicaEntries(): void {}

    endReplica(_grant: ShareTransportGrant, _reason: ScopeShareReplicaEndedReason): "ended" {
        return "ended";
    }
}
