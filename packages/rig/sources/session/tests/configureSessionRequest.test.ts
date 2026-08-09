import { expect, it } from "vitest";

import { configureSessionRequest } from "../configureSessionRequest.js";
import { SessionConfigurationError } from "../SessionConfigurationError.js";

it("applies the daemon Docker default to remotely created sessions", async () => {
    await expect(
        configureSessionRequest(
            { cwd: "/workspace", permissionMode: "auto" },
            { image: "node:latest", workingDirectory: "/workspace" },
        ),
    ).resolves.toMatchObject({
        cwd: "/workspace",
        docker: { image: "node:latest" },
        permissionMode: "auto",
    });
    await expect(
        configureSessionRequest(
            { cwd: "/workspace", local: true, permissionMode: "auto" },
            { image: "node:latest", workingDirectory: "/workspace" },
        ),
    ).resolves.not.toHaveProperty("docker");
});

it("prefers the project compute default over the daemon default", async () => {
    await expect(
        configureSessionRequest(
            { cwd: "/projects/rig", permissionMode: "auto" },
            { image: "daemon:latest", workingDirectory: "/workspace" },
            () => ({
                projectId: "project-1",
                settings: {
                    defaultWorkspaceCompute: {
                        generation: 1,
                        image: "project:latest",
                        type: "docker",
                    },
                },
            }),
        ),
    ).resolves.toMatchObject({
        docker: {
            image: "project:latest",
            mounts: expect.arrayContaining([{ source: "/projects/rig", target: "/workspace" }]),
            name: "rig-project-project-1-1",
            workingDirectory: "/workspace",
        },
    });
    await expect(
        configureSessionRequest(
            { cwd: "/workspaces/feature", permissionMode: "auto" },
            undefined,
            () => ({
                projectId: "project-1",
                settings: {
                    defaultWorkspaceCompute: {
                        generation: 3,
                        image: "project:latest",
                        type: "docker",
                    },
                },
                workspaceId: "workspace-1",
            }),
        ),
    ).resolves.toMatchObject({
        docker: { name: "rig-workspace-workspace-1-3" },
    });
    await expect(
        configureSessionRequest(
            { cwd: "/projects/rig", permissionMode: "auto" },
            { image: "daemon:latest", workingDirectory: "/workspace" },
            () => ({
                projectId: "project-1",
                settings: {
                    defaultWorkspaceCompute: { generation: 2, type: "local" },
                },
            }),
        ),
    ).resolves.not.toHaveProperty("docker");
});

it("keeps an explicit session compute choice ahead of the project default", async () => {
    const queryProjectSettings = async () => {
        throw new Error("Project settings should not be read for an explicit choice.");
    };
    await expect(
        configureSessionRequest(
            { cwd: "/workspace", local: true },
            { image: "daemon:latest", workingDirectory: "/workspace" },
            queryProjectSettings,
        ),
    ).resolves.not.toHaveProperty("docker");
    await expect(
        configureSessionRequest(
            {
                cwd: "/workspace",
                docker: { image: "explicit:latest", workingDirectory: "/work" },
            },
            undefined,
            queryProjectSettings,
        ),
    ).resolves.toMatchObject({
        docker: { image: "explicit:latest", workingDirectory: "/work" },
    });
});

it("classifies conflicting and malformed execution settings as client errors", async () => {
    await expect(
        configureSessionRequest(
            {
                cwd: "/workspace",
                docker: { image: "node:latest", workingDirectory: "/workspace" },
                local: true,
            },
            undefined,
        ),
    ).rejects.toThrow(SessionConfigurationError);
    await expect(
        configureSessionRequest(
            {
                cwd: "/workspace",
                docker: { image: "node:latest", workingDirectory: "relative" },
            },
            undefined,
        ),
    ).rejects.toThrow(SessionConfigurationError);
});
