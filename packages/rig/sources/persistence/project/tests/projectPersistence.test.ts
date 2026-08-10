import { withDatabase } from "../../database/databaseContext.js";

import { createTestRootContext } from "../../../testing/createTestRootContext.js";

import type { Span, Tracer } from "@opentelemetry/api";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { migrateSessionDatabase } from "../../database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { projectAvatarAssets, projects, projectWorkspaces } from "../../database/schema.js";
import { inTx } from "../../inTx.js";
import { projectRefresh } from "../projectRefresh.js";
import { projectSetAvatar } from "../projectSetAvatar.js";
import { projectSetSettings } from "../projectSetSettings.js";
import { queryProject } from "../queryProject.js";
import { workspaceReserve } from "../workspaceReserve.js";
import { workspaceApplyProbe } from "../workspaceApplyProbe.js";

describe("project persistence", () => {
    it("uses a stable semantic SQL span name", async () => {
        const opened = await databaseWithProject();
        const spanNames: string[] = [];

        await queryProject(
            withDatabase(createTestRootContext(recordingTracer(spanNames)), opened.database),
            "project-1",
        );

        expect(spanNames).toEqual(["rig.sql.project.queryProject"]);
        opened.client.close();
    });

    it("rolls back the avatar asset and project reference together", async () => {
        const opened = await databaseWithProject();

        await expect(
            inTx(
                withDatabase(createTestRootContext(), opened.database),
                "rig.sql.project.test.rollbackAvatar",
                async (ctx) => {
                    await projectSetAvatar(ctx, {
                        asset: { byteLength: 3, hash: "a".repeat(64), height: 1, width: 1 },
                        now: 2,
                        projectId: "project-1",
                        source: "user",
                    });
                    throw new Error("fail after avatar");
                },
            ),
        ).rejects.toThrow("fail after avatar");

        expect(await opened.database.select().from(projectAvatarAssets).all()).toEqual([]);
        expect(
            await opened.database
                .select({ avatarHash: projects.avatarHash })
                .from(projects)
                .where(eq(projects.id, "project-1"))
                .get(),
        ).toEqual({ avatarHash: null });
        opened.client.close();
    });

    it("rolls back a complete workspace reservation with its outer action", async () => {
        const opened = await databaseWithProject();

        await expect(
            inTx(
                withDatabase(createTestRootContext(), opened.database),
                "rig.sql.project.test.rollbackWorkspace",
                async (ctx) => {
                    await workspaceReserve(ctx, {
                        baseCommit: "a".repeat(40),
                        baseRef: "main",
                        gitCommonDir: "/workspace/.git",
                        id: "workspace-1",
                        name: "Feature",
                        now: 2,
                        pathForStorageKey: (key) => `/state/workspaces/project/${key}`,
                        projectId: "project-1",
                    });
                    throw new Error("fail after workspace");
                },
            ),
        ).rejects.toThrow("fail after workspace");

        expect(await opened.database.select().from(projectWorkspaces).all()).toEqual([]);
        opened.client.close();
    });

    it("does not let an initialization-era probe overwrite workspace presence", async () => {
        const opened = await databaseWithProject();
        await workspaceReserve(withDatabase(createTestRootContext(), opened.database), {
            id: "workspace-1",
            name: "Feature",
            now: 2,
            pathForStorageKey: (key) => `/state/workspaces/project/${key}`,
            projectId: "project-1",
        });

        expect(
            await workspaceApplyProbe(
                withDatabase(createTestRootContext(), opened.database),
                "project-1",
                "workspace-1",
                {
                    gitAhead: 0,
                    gitBehind: 0,
                    gitBranch: null,
                    gitDetached: false,
                    gitHead: null,
                    gitUpstream: null,
                    presence: "missing",
                },
                3,
            ),
        ).toBe(0);
        expect(
            await opened.database
                .select({
                    presence: projectWorkspaces.presence,
                    status: projectWorkspaces.status,
                })
                .from(projectWorkspaces)
                .where(eq(projectWorkspaces.id, "workspace-1"))
                .get(),
        ).toEqual({ presence: "present", status: "initializing" });
        opened.client.close();
    });

    it("stores and clears the default workspace compute atomically", async () => {
        const opened = await databaseWithProject();

        expect(
            await projectSetSettings(
                withDatabase(createTestRootContext(), opened.database),
                "project-1",
                { defaultWorkspaceCompute: { image: "rig-dev:latest", type: "docker" } },
                2,
                1,
            ),
        ).toBe(1);
        expect(
            await queryProject(withDatabase(createTestRootContext(), opened.database), "project-1"),
        ).toMatchObject({
            settings: {
                defaultWorkspaceCompute: {
                    generation: 1,
                    image: "rig-dev:latest",
                    type: "docker",
                },
            },
            version: 2,
        });

        expect(
            await projectSetSettings(
                withDatabase(createTestRootContext(), opened.database),
                "project-1",
                { defaultWorkspaceCompute: { image: "rig-dev:latest", type: "docker" } },
                3,
                2,
            ),
        ).toBe(1);
        expect(
            await queryProject(withDatabase(createTestRootContext(), opened.database), "project-1"),
        ).toMatchObject({
            settings: {
                defaultWorkspaceCompute: {
                    generation: 1,
                    image: "rig-dev:latest",
                    type: "docker",
                },
            },
            version: 3,
        });
        expect(
            await projectSetSettings(
                withDatabase(createTestRootContext(), opened.database),
                "project-1",
                { defaultWorkspaceCompute: { type: "local" } },
                4,
                3,
            ),
        ).toBe(1);
        expect(
            await queryProject(withDatabase(createTestRootContext(), opened.database), "project-1"),
        ).toMatchObject({
            settings: {
                defaultWorkspaceCompute: {
                    generation: 2,
                    type: "local",
                },
            },
            version: 4,
        });
        await expect(
            projectSetSettings(
                withDatabase(createTestRootContext(), opened.database),
                "project-1",
                { defaultWorkspaceCompute: { image: "invalid image", type: "docker" } },
                5,
                4,
            ),
        ).rejects.toThrow("must not contain whitespace");
        opened.client.close();
    });

    it("guards settings with the last user mutation rather than enrichment", async () => {
        const opened = await databaseWithProject();
        await opened.database
            .update(projects)
            .set({ version: sql`${projects.version} + 1` })
            .where(eq(projects.id, "project-1"))
            .run();

        expect(
            await projectSetSettings(
                withDatabase(createTestRootContext(), opened.database),
                "project-1",
                { defaultWorkspaceCompute: { type: "local" } },
                2,
                1,
            ),
        ).toBe(1);
        expect(
            await projectSetSettings(
                withDatabase(createTestRootContext(), opened.database),
                "project-1",
                { defaultWorkspaceCompute: { type: "docker", image: "rig-dev:latest" } },
                3,
                2,
            ),
        ).toBe(0);
        opened.client.close();
    });

    it("keeps refresh out of the user mutation watermark", async () => {
        const opened = await databaseWithProject();

        expect(
            await projectRefresh(
                withDatabase(createTestRootContext(), opened.database),
                "project-1",
                2,
            ),
        ).toBe(1);
        expect(
            await opened.database
                .select({
                    userMutationVersion: projects.userMutationVersion,
                    version: projects.version,
                })
                .from(projects)
                .where(eq(projects.id, "project-1"))
                .get(),
        ).toEqual({ userMutationVersion: 1, version: 2 });
        opened.client.close();
    });
});

async function databaseWithProject(): Promise<
    Awaited<Awaited<ReturnType<typeof openSessionDatabase>>>
> {
    const opened = await openSessionDatabase(createTestRootContext(), ":memory:");
    await migrateSessionDatabase(withDatabase(createTestRootContext(), opened.database));
    await opened.database
        .insert(projects)
        .values({
            createdAtMs: 1,
            gitAhead: 0,
            gitBehind: 0,
            gitDetached: false,
            id: "project-1",
            initializationAttempt: 0,
            initializationStatus: "ready",
            kind: "regular",
            name: "Project",
            nameKey: "project",
            nameSource: "folder",
            orderKey: "a0",
            path: "/workspace",
            presence: "present",
            storageKey: "project",
            updatedAtMs: 1,
            version: 1,
            worktreeSupport: "supported",
        })
        .run();
    return opened;
}

function recordingTracer(spanNames: string[]): Tracer {
    return {
        startSpan(name: string) {
            spanNames.push(name);
            return testSpan();
        },
    } as unknown as Tracer;
}

function testSpan(): Span {
    const span: Span = {
        addEvent: () => span,
        addLink: () => span,
        addLinks: () => span,
        end: () => undefined,
        isRecording: () => true,
        recordException: () => undefined,
        setAttribute: () => span,
        setAttributes: () => span,
        setStatus: () => span,
        spanContext: () => ({ spanId: "0000000000000000", traceFlags: 0, traceId: "0".repeat(32) }),
        updateName: () => span,
    };
    return span;
}
