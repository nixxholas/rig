import { chmod, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    DOCKER_NETWORK_BRIDGE_DIRECTORY,
    prepareDockerNetworkBridgeHostRoot,
} from "../../../sources/docker/impl/prepareDockerNetworkBridgeHostRoot.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("prepareDockerNetworkBridgeHostRoot", () => {
    it("makes the reserved root traversable by a different container UID", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "compute-docker-bridge-permissions-"));
        temporaryDirectories.push(workspace);
        const root = await prepareDockerNetworkBridgeHostRoot(workspace);
        await chmod(root, 0o700);

        await prepareDockerNetworkBridgeHostRoot(workspace);

        expect((await stat(root)).mode & 0o777).toBe(0o733);
    });

    it("rejects a repository symlink instead of creating bridge sockets outside the workspace", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "compute-docker-bridge-workspace-"));
        const outside = await mkdtemp(join(tmpdir(), "compute-docker-bridge-outside-"));
        temporaryDirectories.push(workspace, outside);
        await symlink(outside, join(workspace, DOCKER_NETWORK_BRIDGE_DIRECTORY), "dir");

        await expect(prepareDockerNetworkBridgeHostRoot(workspace)).rejects.toThrow(
            "must be a real directory inside the workspace",
        );
        await expect(readdir(outside)).resolves.toEqual([]);
    });
});
