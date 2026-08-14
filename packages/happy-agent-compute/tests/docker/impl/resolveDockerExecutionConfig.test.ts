import { describe, expect, it } from "vitest";

import { resolveDockerExecutionConfig } from "../../../sources/docker/impl/resolveDockerExecutionConfig.js";

const reservedMounts = [
    { readOnly: true, source: "/bundled/docs", target: "/product/docs" },
    { readOnly: true, source: "/host/generated", target: "/product/output" },
] as const;

describe("resolveDockerExecutionConfig", () => {
    it("resolves relative sources for configured and caller-named reserved mounts", () => {
        const resolved = resolveDockerExecutionConfig(
            {
                image: "test:local",
                mounts: [{ source: ".", target: "/workspace" }],
                workingDirectory: "/workspace",
            },
            "/tmp/project",
            reservedMounts,
        );

        expect(resolved.mounts).toEqual([
            { source: "/tmp/project", target: "/workspace" },
            { readOnly: true, source: "/bundled/docs", target: "/product/docs" },
            { readOnly: true, source: "/host/generated", target: "/product/output" },
        ]);
    });

    it("does not reserve any container destination", () => {
        const resolved = resolveDockerExecutionConfig(
            {
                image: "test:local",
                mounts: [{ source: "/first", target: "/product/output" }],
                workingDirectory: "/workspace",
            },
            "/tmp/project",
            [{ source: "/second", target: "/product/output" }],
        );

        expect(resolved.mounts).toEqual([
            { source: "/first", target: "/product/output" },
            { source: "/second", target: "/product/output" },
        ]);
    });

    it("omits extra mounts when the caller supplies none", () => {
        const resolved = resolveDockerExecutionConfig(
            {
                image: "test:local",
                mounts: [{ source: ".", target: "/workspace" }],
                workingDirectory: "/workspace",
            },
            "/tmp/project",
        );

        expect(resolved.mounts).toEqual([{ source: "/tmp/project", target: "/workspace" }]);
    });

    it("does not add mounts when connecting to an existing container", () => {
        const resolved = resolveDockerExecutionConfig(
            { container: "already-running", workingDirectory: "/repo" },
            "/tmp/project",
            reservedMounts,
        );

        expect(resolved.mounts).toBeUndefined();
    });
});
