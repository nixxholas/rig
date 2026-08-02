import { expect, it } from "vitest";

import { configureSessionRequest } from "../configureSessionRequest.js";
import { SessionConfigurationError } from "../SessionConfigurationError.js";

it("applies the daemon Docker default to remotely created sessions", () => {
    expect(
        configureSessionRequest(
            { cwd: "/workspace", permissionMode: "auto" },
            { image: "node:latest", workingDirectory: "/workspace" },
        ),
    ).toMatchObject({
        cwd: "/workspace",
        docker: { image: "node:latest" },
        permissionMode: "auto",
    });
    expect(
        configureSessionRequest(
            { cwd: "/workspace", local: true, permissionMode: "auto" },
            { image: "node:latest", workingDirectory: "/workspace" },
        ),
    ).not.toHaveProperty("docker");
});

it("prefers the project compute default over the daemon default", () => {
    expect(
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
    ).toMatchObject({
        docker: {
            image: "project:latest",
            mounts: expect.arrayContaining([{ source: "/projects/rig", target: "/workspace" }]),
            name: "rig-project-project-1-1",
            workingDirectory: "/workspace",
        },
    });
    expect(
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
    ).toMatchObject({
        docker: { name: "rig-workspace-workspace-1-3" },
    });
    expect(
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
    ).not.toHaveProperty("docker");
});

it("keeps an explicit session compute choice ahead of the project default", () => {
    const queryProjectSettings = () => {
        throw new Error("Project settings should not be read for an explicit choice.");
    };
    expect(
        configureSessionRequest(
            { cwd: "/workspace", local: true },
            { image: "daemon:latest", workingDirectory: "/workspace" },
            queryProjectSettings,
        ),
    ).not.toHaveProperty("docker");
    expect(
        configureSessionRequest(
            {
                cwd: "/workspace",
                docker: { image: "explicit:latest", workingDirectory: "/work" },
            },
            undefined,
            queryProjectSettings,
        ),
    ).toMatchObject({ docker: { image: "explicit:latest", workingDirectory: "/work" } });
});

it("classifies conflicting and malformed execution settings as client errors", () => {
    expect(() =>
        configureSessionRequest(
            {
                cwd: "/workspace",
                docker: { image: "node:latest", workingDirectory: "/workspace" },
                local: true,
            },
            undefined,
        ),
    ).toThrow(SessionConfigurationError);
    expect(() =>
        configureSessionRequest(
            {
                cwd: "/workspace",
                docker: { image: "node:latest", workingDirectory: "relative" },
            },
            undefined,
        ),
    ).toThrow(SessionConfigurationError);
});
