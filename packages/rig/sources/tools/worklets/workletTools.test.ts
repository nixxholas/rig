import { describe, expect, it, vi } from "vitest";

import type { AgentContext } from "../../agent/context/AgentContext.js";
import type { WorkletContext } from "../../agent/context/WorkletContext.js";
import type { Worklet } from "../../protocol/WorkletProtocol.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";
import {
    workletInstallTool,
    workletListTool,
    workletLogsTool,
    workletRevertTool,
    workletUninstallTool,
    workletUpdateTool,
} from "./workletTools.js";

const SEALED = { disk: "none", network: "none" } as const;

describe("worklet tools", () => {
    it("reviews every change to the installed set and leaves reading alone", () => {
        const context = createContext();

        for (const tool of [
            workletInstallTool,
            workletUpdateTool,
            workletRevertTool,
            workletUninstallTool,
        ]) {
            expect(tool.requiresAutoOrFullAccess).toBe(true);
            expect(tool.shouldReviewInAutoMode({} as never, context)).toBe(true);
        }
        // Reverting restarts code already on disk, so it needs no host access of its own.
        expect(
            workletRevertTool.shouldRunInFullAccessInAutoMode?.(
                { name: "github-watch", permissions: SEALED, version: 1 },
                context,
            ),
        ).toBe(false);
        for (const tool of [workletInstallTool, workletUpdateTool, workletUninstallTool]) {
            expect(tool.shouldRunInFullAccessInAutoMode?.({} as never, context)).toBe(true);
        }
        expect(workletListTool.shouldReviewInAutoMode({}, context)).toBe(false);
        expect(workletLogsTool.shouldReviewInAutoMode({ name: "github-watch" }, context)).toBe(
            false,
        );
    });

    it("discloses the folders it reaches and that the worklet runs outside the sandbox", () => {
        const context = createContext();

        const install = workletInstallTool.describeAutoPermissionAction?.(
            { iconPath: "/workspace/icon.png", path: "/workspace/watch", permissions: SEALED },
            context,
        );
        expect(install).toContain("/workspace/watch");
        expect(install).toContain("/workspace/icon.png");
        expect(install).toContain("outside the workspace sandbox");
        // The exact powers are stated, and the staged manifest must match the reviewed values.
        expect(install).toContain("worklet.json");
        expect(install).toContain("write only its own persistent Data folder");
        expect(install).toContain("no IP network access");
        expect(install).toContain("refuse the install");

        expect(
            workletUninstallTool.describeAutoPermissionAction?.({ name: "github-watch" }, context),
        ).toContain("keeping its Data folder");
        expect(
            workletRevertTool.describeAutoPermissionAction?.(
                { name: "github-watch", permissions: SEALED, version: 2 },
                context,
            ),
        ).toContain("v2");
    });

    it("refuses a source folder outside the workspace before reaching the worklet", async () => {
        const install = vi.fn();
        const context = createContext({ install });
        const ctx = createTestRootContext().named("worklet-tools-test");

        await expect(
            workletInstallTool.execute(
                {
                    iconPath: "/elsewhere/icon.png",
                    path: "/elsewhere/watch",
                    permissions: SEALED,
                },
                context,
                { ctx },
            ),
        ).rejects.toThrow("inside the active workspace");
        expect(install).not.toHaveBeenCalled();
    });

    it("installs, updates, reverts, uninstalls, lists, and reads a log", async () => {
        const worklet = createWorklet();
        const install = vi.fn(async () => worklet);
        const update = vi.fn(async () => ({ ...worklet, currentVersion: 2 }));
        const revert = vi.fn(async () => worklet);
        const uninstall = vi.fn(async () => undefined);
        const readLog = vi.fn(async () => ({ log: "watching", truncated: false }));
        const context = createContext({
            install,
            list: async () => [worklet],
            readLog,
            revert,
            uninstall,
            update,
        });
        const ctx = createTestRootContext().named("worklet-tools-test");
        const request = {
            iconPath: "/workspace/icon.png",
            path: "/workspace/watch",
            permissions: SEALED,
        };

        await expect(workletInstallTool.execute(request, context, { ctx })).resolves.toBe(worklet);
        // The session bakes in authorship and the folder names itself, so neither is passed along.
        expect(install).toHaveBeenCalledWith(
            ctx,
            { iconPath: request.iconPath, path: request.path },
            context.fs,
            SEALED,
        );

        await expect(
            workletUpdateTool.execute(
                {
                    changeDescription: "More repositories",
                    name: "github-watch",
                    path: "/workspace/watch",
                    permissions: SEALED,
                },
                context,
                { ctx },
            ),
        ).resolves.toMatchObject({ currentVersion: 2 });
        expect(update).toHaveBeenCalledWith(
            ctx,
            "github-watch",
            { changeDescription: "More repositories", path: "/workspace/watch" },
            context.fs,
            SEALED,
        );

        await workletRevertTool.execute(
            { name: "github-watch", permissions: SEALED, version: 1 },
            context,
            { ctx },
        );
        expect(revert).toHaveBeenCalledWith(ctx, "github-watch", { version: 1 }, SEALED);

        await expect(
            workletUninstallTool.execute({ name: "github-watch" }, context, { ctx }),
        ).resolves.toEqual({ name: "github-watch" });
        expect(uninstall).toHaveBeenCalledWith(ctx, "github-watch");

        await expect(workletListTool.execute({}, context, { ctx })).resolves.toEqual({
            worklets: [worklet],
        });
        await expect(
            workletLogsTool.execute({ name: "github-watch" }, context, { ctx }),
        ).resolves.toEqual({ log: "watching", truncated: false });
    });

    it("says plainly when a session has no worklets", async () => {
        const context = { fs: { cwd: "/workspace" } } as AgentContext;
        const ctx = createTestRootContext().named("worklet-tools-test");

        await expect(workletListTool.execute({}, context, { ctx })).rejects.toThrow(
            "Worklets are unavailable in this session.",
        );
    });

    it("describes what it did in words a person reads", () => {
        const worklet = createWorklet();
        const install = {
            iconPath: "/workspace/icon.png",
            path: "/workspace/watch",
            permissions: SEALED,
        };

        expect(workletInstallTool.toUI(worklet, install)).toBe(
            "Installed the github-watch worklet at version v1.",
        );
        expect(
            workletUpdateTool.toUI(
                { ...worklet, currentVersion: 3 },
                {
                    changeDescription: "More",
                    name: "github-watch",
                    path: "/workspace/watch",
                    permissions: SEALED,
                },
            ),
        ).toBe("Updated the github-watch worklet to version v3.");
        expect(workletUninstallTool.toUI({ name: "github-watch" }, { name: "github-watch" })).toBe(
            "Uninstalled the github-watch worklet and kept its data.",
        );
        expect(workletListTool.toUI({ worklets: [] }, {})).toBe("No worklets are installed.");
        expect(workletListTool.toUI({ worklets: [worklet] }, {})).toBe("Found 1 worklet.");
        expect(workletLogsTool.toUI({ log: "", truncated: false }, { name: "github-watch" })).toBe(
            "The worklet has no output yet.",
        );
    });
});

function createWorklet(): Worklet {
    return {
        authorSessionId: "agent-1",
        createdAt: 1,
        currentVersion: 1,
        dataDirectory: "/home/steve/Happy/Worklets/github-watch/Data",
        description: "Watches a repository",
        iconThumbhash: "thumb",
        iconUrl: "/worklets/github-watch/favicon.png",
        name: "github-watch",
        permissions: { disk: "none", network: "none" },
        state: "running",
        tools: [],
        updatedAt: 1,
        versions: [
            {
                changeDescription: "Initial import",
                createdAt: 1,
                description: "Watches a repository",
                permissions: { disk: "none", network: "none" },
                version: 1,
            },
        ],
    };
}

function createContext(worklets: Partial<WorkletContext> = {}): AgentContext {
    return {
        fs: {
            cwd: "/workspace",
            realpath: async (path: string) => path,
        },
        worklets: {
            install: async () => {
                throw new Error("unexpected install");
            },
            list: () => [],
            readLog: async () => {
                throw new Error("unexpected log read");
            },
            revert: async () => {
                throw new Error("unexpected revert");
            },
            uninstall: async () => {
                throw new Error("unexpected uninstall");
            },
            update: async () => {
                throw new Error("unexpected update");
            },
            ...worklets,
        },
    } as unknown as AgentContext;
}
