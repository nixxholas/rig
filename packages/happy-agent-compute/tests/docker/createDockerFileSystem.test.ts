import { PassThrough } from "node:stream";

import type Dockerode from "dockerode";
import { describe, expect, it } from "vitest";

import { computePermissions } from "../../sources/ComputePermissions.js";
import { createDockerFileSystem } from "../../sources/docker/createDockerFileSystem.js";
import type { DockerEnvironment } from "../../sources/docker/DockerEnvironment.js";

interface ScriptedExec {
    exitCode?: number;
    stdout?: string | Buffer;
}

/** A container that answers each `exec` with the next scripted result and records the command. */
function scriptedContainer(responses: readonly ScriptedExec[]): {
    commands: string[][];
    container: Dockerode.Container;
} {
    const commands: string[][] = [];
    let index = 0;
    const container = {
        async exec(options: { AttachStdin?: boolean; Cmd?: string[] }) {
            commands.push(options.Cmd ?? []);
            const response = responses[index++] ?? {};
            return {
                inspect: async () => ({ ExitCode: response.exitCode ?? 0 }),
                async start() {
                    const stream = new PassThrough();
                    if (options.AttachStdin !== true) {
                        queueMicrotask(() => stream.end(Buffer.from(response.stdout ?? "")));
                    }
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
    return { commands, container };
}

function environmentFor(container: Dockerode.Container): DockerEnvironment {
    return {
        config: { workingDirectory: "/workspace" },
        container: async () => container,
    } as unknown as DockerEnvironment;
}

const fullAccess = () => computePermissions("full_access");

function archivedFileContainer(
    type: "file" | "symlink",
    content: string,
): {
    archivePaths: string[];
    commands: string[][];
    container: Dockerode.Container;
} {
    const archivePaths: string[] = [];
    const commands: string[][] = [];
    const container = {
        async exec(options: { Cmd?: string[] }) {
            commands.push(options.Cmd ?? []);
            throw new Error("An atomic no-follow read must not execute a check-then-read script.");
        },
        async getArchive(options: { path: string }) {
            archivePaths.push(options.path);
            const stream = new PassThrough();
            queueMicrotask(() => stream.end(createTarEntry(type, content)));
            return stream;
        },
    } as unknown as Dockerode.Container;
    return { archivePaths, commands, container };
}

function createTarEntry(type: "file" | "symlink", content: string): Buffer {
    const header = Buffer.alloc(512);
    header.write("result.txt", 0, "utf8");
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    const body = type === "file" ? Buffer.from(content) : Buffer.alloc(0);
    header.write(`${body.byteLength.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    header.write("00000000000\0", 136, "ascii");
    header.fill(0x20, 148, 156);
    header[156] = type === "file" ? 0x30 : 0x32;
    if (type === "symlink") header.write("target.txt", 157, "utf8");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    const padding = Buffer.alloc((512 - (body.byteLength % 512)) % 512);
    return Buffer.concat([header, body, padding, Buffer.alloc(1024)]);
}

describe("createDockerFileSystem", () => {
    it("reports symbolic links without dereferencing their targets", async () => {
        const { commands, container } = scriptedContainer([
            { stdout: "symlink\n12\n1750000000\n777\n" },
        ]);
        const fs = createDockerFileSystem(environmentFor(container));

        await expect(fs.lstat(fullAccess(), "/workspace/link")).resolves.toEqual({
            isDirectory: false,
            isFile: false,
            isSymbolicLink: true,
            mode: 0o777,
            mtimeMs: 1_750_000_000_000,
            size: 12,
        });
        expect(commands[0]?.at(-1)).toBe("/workspace/link");
    });

    it("reads one regular file without following a symbolic link at its final component", async () => {
        const { archivePaths, commands, container } = archivedFileContainer("file", "done");
        const fs = createDockerFileSystem(environmentFor(container));

        await expect(
            fs.readFileBuffer(fullAccess(), "/workspace/result.txt", {
                maxBytes: 4,
                noFollow: true,
            }),
        ).resolves.toEqual(Buffer.from("done"));
        expect(archivePaths).toEqual(["/workspace/result.txt"]);
        expect(commands).toEqual([]);
    });

    it("refuses a no-follow read of a symbolic link", async () => {
        const { archivePaths, commands, container } = archivedFileContainer("symlink", "");
        const fs = createDockerFileSystem(environmentFor(container));

        await expect(
            fs.readFileBuffer(fullAccess(), "/workspace/result.txt", {
                maxBytes: 4,
                noFollow: true,
            }),
        ).rejects.toThrow("symbolic link");
        expect(archivePaths).toEqual(["/workspace/result.txt"]);
        expect(commands).toEqual([]);
    });

    it("restores modification times with a BusyBox-portable UTC touch command", async () => {
        const { commands, container } = scriptedContainer([{ exitCode: 0 }]);
        const fs = createDockerFileSystem(environmentFor(container));

        await fs.setModificationTime(
            fullAccess(),
            "/workspace/file.txt",
            Date.parse("2026-07-14T07:14:29.097Z"),
        );

        expect(commands).toEqual([
            ["env", "TZ=UTC0", "touch", "-m", "-t", "202607140714.29", "--", "/workspace/file.txt"],
        ]);
    });

    it("requests a bounded null-delimited directory page inside the container", async () => {
        const { commands, container } = scriptedContainer([
            { stdout: "line\nbreak\0zeta\0éclair\0" },
        ]);
        const fs = createDockerFileSystem(environmentFor(container));

        await expect(
            fs.readdirPage(fullAccess(), "/workspace", { after: "alpha", limit: 2 }),
        ).resolves.toEqual({
            entries: ["line\nbreak", "zeta"],
            hasMore: true,
        });
        expect(commands[0]?.slice(-3)).toEqual(["/workspace", "alpha", "768"]);
        expect(commands[0]?.[2]).toContain("find . -mindepth 1 -maxdepth 1");
        expect(commands[0]?.[2]).toContain("sort -z");
    });

    it("batches directory-entry metadata into one container command", async () => {
        const { commands, container } = scriptedContainer([
            {
                stdout: "file\n4\n1750000000\n644\nmissing\n0\n0\n0\ndirectory\n0\n1750000001\n755\n",
            },
        ]);
        const fs = createDockerFileSystem(environmentFor(container));

        await expect(
            fs.lstatMany(fullAccess(), [
                "/workspace/one.txt",
                "/workspace/gone.txt",
                "/workspace/folder",
            ]),
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

    it("refuses writes in read-only mode before touching the container", async () => {
        const { commands, container } = scriptedContainer([]);
        const fs = createDockerFileSystem(environmentFor(container));

        await expect(
            fs.writeFile(computePermissions("read_only"), "notes.txt", "hi"),
        ).rejects.toThrow("File changes are disabled in read-only mode.");
        expect(commands).toEqual([]);
    });

    it("checks the permissions supplied to each filesystem operation independently", async () => {
        const { commands, container } = scriptedContainer([
            { stdout: "/workspace/notes.txt" },
            { stdout: "/workspace" },
            { exitCode: 0 },
            { exitCode: 0 },
        ]);
        const fs = createDockerFileSystem(environmentFor(container));

        await expect(
            fs.writeFile(computePermissions("read_only"), "notes.txt", "blocked"),
        ).rejects.toThrow("File changes are disabled in read-only mode.");
        await expect(
            fs.writeFile(computePermissions("workspace_write"), "notes.txt", "allowed"),
        ).resolves.toBeUndefined();

        expect(commands).toHaveLength(4);
    });
});
