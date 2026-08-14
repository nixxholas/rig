import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import type { Compute } from "../../sources/Compute.js";
import { computePermissions } from "../../sources/ComputePermissions.js";
import { createJustBashCompute } from "../../sources/justBash/createJustBashCompute.js";

const LIVE = process.env.HAPPY_AGENT_COMPUTE_LIVE_TEST === "1";
const describeLive = LIVE ? describe : describe.skip;
const unusedContext = {} as Context;
const computes = new Set<Compute>();

describeLive("live just-bash operation-scoped permission boundary", () => {
    afterEach(async () => {
        await Promise.all([...computes].map((compute) => compute.dispose(unusedContext)));
        computes.clear();
    });

    it("applies granular grants and denials to direct filesystem and real shell execution", async () => {
        const compute = createJustBashCompute({
            storage: "memory",
            cwd: "/workspace",
            files: {
                "/outside/allowed.txt": "readable",
                "/outside/private/secret.txt": "hidden",
                "/workspace/private/secret.txt": "workspace-hidden",
            },
        });
        computes.add(compute);
        const granted = computePermissions("workspace_write", {
            allowedReadPaths: ["/outside"],
            allowedWritePaths: ["/output"],
        });
        const denied = computePermissions("full_access", {
            allowedReadPaths: ["/outside/private", "/workspace/private"],
            deniedReadPaths: ["/outside/private", "/workspace/private"],
            allowedWritePaths: ["/output"],
            deniedWritePaths: ["/output/private"],
        });

        await compute.fs.writeFile(granted, "/output/artifact.txt", "direct");
        await expect(compute.fs.readFile(granted, "/outside/allowed.txt")).resolves.toBe(
            "readable",
        );
        await expect(compute.fs.readFile(denied, "/outside/private/secret.txt")).rejects.toThrow(
            "denied path",
        );
        await expect(
            compute.fs.writeFile(denied, "/output/private/blocked.txt", "forbidden"),
        ).rejects.toThrow("denied path");

        const shell = await compute.shell.run({
            command: [
                "cat /outside/allowed.txt",
                "printf shell > /output/shell.txt",
                "cat /workspace/private/secret.txt",
            ].join("\n"),
            permissions: denied,
        });
        expect(shell.exitCode).not.toBe(0);
        expect(shell.stdout).toContain("readable");
        expect(shell.stdout).not.toContain("workspace-hidden");
        await expect(compute.fs.readFile(granted, "/output/shell.txt")).resolves.toBe("shell");
        await expect(
            compute.fs.exists(computePermissions("full_access"), "/output/private/blocked.txt"),
        ).resolves.toBe(false);
    });

    it("uses each operation's permission value without retaining a previous grant", async () => {
        const compute = createJustBashCompute({
            storage: "memory",
            cwd: "/workspace",
        });
        computes.add(compute);
        const allowed = computePermissions("workspace_write", {
            allowedWritePaths: ["/output"],
        });
        const ordinary = computePermissions("workspace_write");

        const first = await compute.shell.run({
            command: "printf first > /output/first.txt",
            permissions: allowed,
        });
        const second = await compute.shell.run({
            command: "printf second > /output/second.txt",
            permissions: ordinary,
        });

        expect(first.exitCode).toBe(0);
        expect(second.exitCode).not.toBe(0);
        await expect(compute.fs.readFile(allowed, "/output/first.txt")).resolves.toBe("first");
        await expect(
            compute.fs.exists(computePermissions("full_access"), "/output/second.txt"),
        ).resolves.toBe(false);
    });
});
