import { PassThrough } from "node:stream";

import type Dockerode from "dockerode";
import { pack as packTar } from "tar-stream";
import { describe, expect, it } from "vitest";

import { createPermissionContext } from "../permissions/index.js";
import { createDockerFileSystemContext } from "./createDockerFileSystemContext.js";
import type { DockerEnvironment } from "./DockerEnvironment.js";

describe("createDockerFileSystemContext", () => {
    it("reads one archived regular file without following a symbolic link", async () => {
        const archive = (type: "file" | "symlink") => {
            const tar = packTar();
            if (type === "file") {
                tar.entry({ name: "result.txt", size: 4, type }, "done");
            } else {
                tar.entry({ linkname: "/private/secret.txt", name: "result.txt", type });
            }
            tar.finalize();
            return tar;
        };
        let type: "file" | "symlink" = "file";
        const container = {
            async getArchive() {
                return archive(type);
            },
        } as unknown as Dockerode.Container;
        const environment = {
            config: { workingDirectory: "/workspace" },
            container: async () => container,
        } as unknown as DockerEnvironment;
        const context = createDockerFileSystemContext(
            environment,
            createPermissionContext("full_access"),
        );

        await expect(
            context.readFileBuffer("/workspace/result.txt", {
                maxBytes: 4,
                noFollow: true,
            }),
        ).resolves.toEqual(Buffer.from("done"));
        type = "symlink";
        await expect(
            context.readFileBuffer("/workspace/result.txt", {
                maxBytes: 4,
                noFollow: true,
            }),
        ).rejects.toThrow("symbolic link");
    });

    it("reports symbolic links without dereferencing their targets", async () => {
        const commands: string[][] = [];
        const container = {
            async exec(options: { Cmd?: string[] }) {
                commands.push(options.Cmd ?? []);
                return {
                    inspect: async () => ({ ExitCode: 0 }),
                    async start() {
                        const stream = new PassThrough();
                        queueMicrotask(() =>
                            stream.end(Buffer.from("symlink\n12\n1750000000\n777\n")),
                        );
                        return stream;
                    },
                };
            },
            modem: {
                demuxStream(
                    stream: NodeJS.ReadableStream,
                    stdout: NodeJS.WritableStream,
                    _stderr: NodeJS.WritableStream,
                ) {
                    stream.pipe(stdout);
                },
            },
        } as unknown as Dockerode.Container;
        const environment = {
            config: { workingDirectory: "/workspace" },
            container: async () => container,
        } as unknown as DockerEnvironment;
        const context = createDockerFileSystemContext(
            environment,
            createPermissionContext("full_access"),
        );

        await expect(context.lstat("/workspace/link")).resolves.toEqual({
            isDirectory: false,
            isFile: false,
            isSymbolicLink: true,
            mode: 0o777,
            mtimeMs: 1_750_000_000_000,
            size: 12,
        });
        expect(commands[0]?.at(-1)).toBe("/workspace/link");
    });

    it("restores modification times with a BusyBox-portable UTC touch command", async () => {
        const commands: string[][] = [];
        const container = {
            async exec(options: { Cmd?: string[] }) {
                commands.push(options.Cmd ?? []);
                return {
                    inspect: async () => ({ ExitCode: 0 }),
                    async start() {
                        const stream = new PassThrough();
                        queueMicrotask(() => stream.end());
                        return stream;
                    },
                };
            },
            modem: {
                demuxStream(
                    stream: NodeJS.ReadableStream,
                    stdout: NodeJS.WritableStream,
                    _stderr: NodeJS.WritableStream,
                ) {
                    stream.pipe(stdout);
                },
            },
        } as unknown as Dockerode.Container;
        const environment = {
            config: { workingDirectory: "/workspace" },
            container: async () => container,
        } as unknown as DockerEnvironment;
        const context = createDockerFileSystemContext(
            environment,
            createPermissionContext("full_access"),
        );

        await context.setModificationTime(
            "/workspace/file.txt",
            Date.parse("2026-07-14T07:14:29.097Z"),
        );

        expect(commands).toEqual([
            ["env", "TZ=UTC0", "touch", "-m", "-t", "202607140714.29", "--", "/workspace/file.txt"],
        ]);
    });
});
