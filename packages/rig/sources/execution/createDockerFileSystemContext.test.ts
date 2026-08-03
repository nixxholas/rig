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

    it("requests a bounded null-delimited directory page inside the container", async () => {
        const commands: string[][] = [];
        const container = {
            async exec(options: { Cmd?: string[] }) {
                commands.push(options.Cmd ?? []);
                return {
                    inspect: async () => ({ ExitCode: 0 }),
                    async start() {
                        const stream = new PassThrough();
                        queueMicrotask(() =>
                            stream.end(Buffer.from("line\nbreak\0zeta\0éclair\0")),
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

        await expect(
            context.readdirPage("/workspace", { after: "alpha", limit: 2 }),
        ).resolves.toEqual({
            entries: ["line\nbreak", "zeta"],
            hasMore: true,
        });
        expect(commands[0]?.slice(-3)).toEqual(["/workspace", "alpha", "768"]);
        expect(commands[0]?.[2]).toContain("find . -mindepth 1 -maxdepth 1");
        expect(commands[0]?.[2]).toContain("sort -z");
        expect(commands[0]?.[2]).toContain('head -c "$3"');
        expect(commands[0]?.[2]).not.toContain("read -r -d");
        expect(commands[0]?.[2]).not.toContain("head -z");
    });

    it("batches directory-entry metadata into one container command", async () => {
        const commands: string[][] = [];
        const container = {
            async exec(options: { Cmd?: string[] }) {
                commands.push(options.Cmd ?? []);
                return {
                    inspect: async () => ({ ExitCode: 0 }),
                    async start() {
                        const stream = new PassThrough();
                        queueMicrotask(() =>
                            stream.end(
                                Buffer.from(
                                    "file\n4\n1750000000\n644\nmissing\n0\n0\n0\ndirectory\n0\n1750000001\n755\n",
                                ),
                            ),
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

        await expect(
            context.lstatMany(["/workspace/one.txt", "/workspace/gone.txt", "/workspace/folder"]),
        ).resolves.toEqual([
            {
                isDirectory: false,
                isFile: true,
                isSymbolicLink: false,
                mode: 0o644,
                mtimeMs: 1_750_000_000_000,
                size: 4,
            },
            undefined,
            {
                isDirectory: true,
                isFile: false,
                isSymbolicLink: false,
                mode: 0o755,
                mtimeMs: 1_750_000_001_000,
                size: 0,
            },
        ]);
        expect(commands).toHaveLength(1);
        expect(commands[0]?.slice(-3)).toEqual([
            "/workspace/one.txt",
            "/workspace/gone.txt",
            "/workspace/folder",
        ]);
    });
});
