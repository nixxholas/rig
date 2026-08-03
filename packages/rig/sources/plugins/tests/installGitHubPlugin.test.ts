import { createGzip } from "node:zlib";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pack as packTar } from "tar-stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createNodeFileSystemContext } from "../../agent/context/createNodeFileSystemContext.js";
import type { GitHubFetch } from "../fetchBoundedGitHubResource.js";
import { installGitHubPlugin } from "../installGitHubPlugin.js";

const PNG_SIGNATURE = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("installing an indexed GitHub plugin", () => {
    it("extracts only the indexed directory and installs it through the local installer", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-github-plugin-"));
        temporaryDirectories.push(root);
        const workspace = join(root, "workspace");
        const pluginsDirectory = join(root, "installed");
        await mkdir(workspace, { recursive: true });
        const archive = await createArchive({
            "repository-root/other/broken.ts": 'const value: number = "wrong";\n',
            "repository-root/plugins/clock/happy.plugin.json": `${JSON.stringify(
                {
                    author: "Happy",
                    category: "utilities",
                    description: "A small clock.",
                    icon: "icon.png",
                    main: "index.ts",
                    name: "Clock",
                    version: "1.2.0",
                },
                null,
                2,
            )}\n`,
            "repository-root/plugins/clock/icon.png": PNG_SIGNATURE,
            "repository-root/plugins/clock/index.ts": 'console.log("ready");\n',
        });
        const index = {
            plugins: [
                {
                    description: "A small clock.",
                    displayName: "Clock",
                    name: "clock",
                    path: "plugins/clock",
                    version: "1.2.0",
                },
            ],
        };
        const fetcher = vi.fn<GitHubFetch>(async (url) =>
            url.includes("raw.githubusercontent.com")
                ? new Response(JSON.stringify(index), { status: 200 })
                : new Response(archive, { status: 200 }),
        );
        const fs = createNodeFileSystemContext(workspace, {
            permissionMode: () => "full_access",
        });

        const installed = await installGitHubPlugin({
            fetcher,
            fs,
            pluginsDirectory,
            source: {
                plugin: "clock",
                ref: "release/1.2.0",
                repository: "happy-dev/plugins",
            },
        });

        expect(installed).toMatchObject({
            classification: "fresh-install",
            folder: "clock",
            name: "Clock",
            version: "1.2.0",
        });
        await expect(readFile(join(installed.directory, "index.ts"), "utf8")).resolves.toContain(
            "ready",
        );
        await expect(fs.readdir(pluginsDirectory)).resolves.toEqual(["clock"]);
        expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
            "https://raw.githubusercontent.com/happy-dev/plugins/release/1.2.0/happy-plugins.json",
            "https://api.github.com/repos/happy-dev/plugins/tarball/release/1.2.0",
        ]);
    });
});

async function createArchive(entries: Readonly<Record<string, string | Buffer>>): Promise<Buffer> {
    const archive = packTar();
    const gzip = createGzip();
    const chunks: Buffer[] = [];
    const completed = new Promise<Buffer>((resolve, reject) => {
        gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
        gzip.once("error", reject);
        gzip.once("end", () => resolve(Buffer.concat(chunks)));
    });
    archive.pipe(gzip);
    for (const [name, value] of Object.entries(entries)) {
        const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
        await new Promise<void>((resolve, reject) => {
            archive.entry({ name, size: body.byteLength, type: "file" }, body, (error) => {
                if (error === null) resolve();
                else reject(error);
            });
        });
    }
    archive.finalize();
    return completed;
}
