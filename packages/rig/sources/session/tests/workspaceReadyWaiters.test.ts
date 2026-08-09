import { describe, expect, it } from "vitest";

import type { ProjectWorkspace } from "../../protocol/index.js";
import { createWorkspaceReadyWaiters } from "../workspaceReadyWaiters.js";

const baseWorkspace: ProjectWorkspace = {
    branch: "workspace-1",
    createdAt: 0,
    gitCommonDir: "/workspaces/.git",
    id: "workspace-1",
    kind: "git_worktree",
    name: "Workspace one",
    orderKey: "a0",
    path: "/workspaces/one",
    presence: "present",
    projectId: "project-1",
    status: "initializing",
    storageKey: "workspace-1",
    updatedAt: 0,
    version: 1,
};

describe("createWorkspaceReadyWaiters", () => {
    it("rejects and unregisters every waiter when a readiness query fails", async () => {
        let initialQueries = 0;
        let mode: "pending" | "ready" | "rejected" = "pending";
        let rejectPending!: (error: Error) => void;
        const pending = new Promise<ProjectWorkspace>((_, reject) => {
            rejectPending = reject;
        });
        const ready: ProjectWorkspace = { ...baseWorkspace, status: "ready" };
        const waiters = createWorkspaceReadyWaiters(async () => {
            if (initialQueries < 2) {
                initialQueries += 1;
                return { ...baseWorkspace, status: "initializing" };
            }
            if (mode === "pending") return pending;
            if (mode === "rejected") return pending;
            return ready;
        });
        const failure = new Error("workspace query failed");

        const first = waiters.wait(baseWorkspace.projectId, baseWorkspace.id);
        const second = waiters.wait(baseWorkspace.projectId, baseWorkspace.id);
        mode = "rejected";
        rejectPending(failure);

        await expect(first).rejects.toBe(failure);
        await expect(second).rejects.toBe(failure);

        mode = "ready";
        await expect(waiters.wait(baseWorkspace.projectId, baseWorkspace.id)).resolves.toEqual(
            ready,
        );
    });
});
