import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { snapshotPluginApps } from "../snapshotPluginApps.js";
import type { RegisteredPlugin } from "../types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

describe("snapshotPluginApps", () => {
    it("derives stable official ui resources from a bounded manifest folder", async () => {
        const root = await fixture();
        await mkdir(join(root, "app", "assets"), { recursive: true });
        await writeFile(join(root, "app", "index.html"), "<script src=assets/main.js></script>");
        await writeFile(join(root, "app", "assets", "main.js"), "export {};\n");

        await expect(snapshotPluginApps(plugin(root))).resolves.toMatchObject([
            {
                id: "usage",
                page: "index.html",
                resourceUri: "ui://usage/usage/index.html",
                resources: [
                    { mediaType: "text/javascript", path: "assets/main.js" },
                    { mediaType: "text/html", path: "index.html" },
                ],
            },
        ]);
    });

    it("rejects unsupported files before the app enters the catalog", async () => {
        const root = await fixture();
        await mkdir(join(root, "app"), { recursive: true });
        await writeFile(join(root, "app", "notes.txt"), "not an allowed app resource");
        await expect(snapshotPluginApps(plugin(root))).rejects.toThrow("unsupported file type");
    });

    it("ignores hidden authoring debris without publishing it", async () => {
        const root = await fixture();
        await mkdir(join(root, "app", ".cache"), { recursive: true });
        await writeFile(join(root, "app", "index.html"), "<h1>Usage</h1>");
        await writeFile(join(root, "app", ".DS_Store"), "debris");
        await writeFile(join(root, "app", ".cache", "notes.txt"), "debris");
        const [app] = await snapshotPluginApps(plugin(root));
        expect(app?.resources.map((resource) => resource.path)).toEqual(["index.html"]);
    });

    it("rejects symlinks, unsafe resource names, and non-file entries", async () => {
        const root = await fixture();
        await mkdir(join(root, "app"), { recursive: true });
        await writeFile(join(root, "app", "index.html"), "<h1>Usage</h1>");
        await symlink(join(root, "app", "index.html"), join(root, "app", "linked.html"));
        await expect(snapshotPluginApps(plugin(root))).rejects.toThrow("symbolic links");
        await rm(join(root, "app", "linked.html"));
        await writeFile(join(root, "app", "bad name.js"), "export {}");
        await expect(snapshotPluginApps(plugin(root))).rejects.toThrow("not URI-safe");
    });

    it("rejects duplicate app IDs and roots outside the plugin", async () => {
        const root = await fixture();
        const duplicate = plugin(root);
        duplicate.manifest.apps = [duplicate.manifest.apps![0]!, duplicate.manifest.apps![0]!];
        await expect(snapshotPluginApps(duplicate)).rejects.toThrow("More than one");
        const escaped = plugin(root);
        escaped.manifest.apps![0]!.root = "../outside";
        await expect(snapshotPluginApps(escaped)).rejects.toThrow("must stay inside");
    });

    it("requires a declared HTML page and an existing image sidebar icon", async () => {
        const root = await fixture();
        await mkdir(join(root, "app"), { recursive: true });
        await writeFile(join(root, "app", "index.js"), "export {}");
        const missingPage = plugin(root);
        await expect(snapshotPluginApps(missingPage)).rejects.toThrow("page must name an HTML");
        await writeFile(join(root, "app", "index.html"), "<h1>Usage</h1>");
        const missingIcon = plugin(root);
        missingIcon.manifest.apps![0]!.sidebar.icon = "missing.png";
        await expect(snapshotPluginApps(missingIcon)).rejects.toThrow("icon does not exist");
        const wrongIcon = plugin(root);
        wrongIcon.manifest.apps![0]!.sidebar.icon = "index.js";
        await expect(snapshotPluginApps(wrongIcon)).rejects.toThrow("icon must be an image");
    });

    it("enforces resource count, per-file size, and aggregate size before reading excess bytes", async () => {
        const countRoot = await fixture();
        await mkdir(join(countRoot, "app"), { recursive: true });
        await writeFile(join(countRoot, "app", "index.html"), "<h1>Usage</h1>");
        for (let index = 0; index < 64; index += 1) {
            await writeFile(join(countRoot, "app", `r-${String(index)}.js`), "");
        }
        await expect(snapshotPluginApps(plugin(countRoot))).rejects.toThrow("more than 64");

        const fileRoot = await fixture();
        await mkdir(join(fileRoot, "app"), { recursive: true });
        await writeFile(join(fileRoot, "app", "index.html"), Buffer.alloc(256 * 1024 + 1));
        await expect(snapshotPluginApps(plugin(fileRoot))).rejects.toThrow(
            "larger than 262144 bytes",
        );

        const totalRoot = await fixture();
        await mkdir(join(totalRoot, "app"), { recursive: true });
        await writeFile(join(totalRoot, "app", "index.html"), Buffer.alloc(256 * 1024));
        for (let index = 0; index < 4; index += 1) {
            await writeFile(
                join(totalRoot, "app", `chunk-${String(index)}.js`),
                Buffer.alloc(256 * 1024),
            );
        }
        await expect(snapshotPluginApps(plugin(totalRoot))).rejects.toThrow(
            "larger than 1048576 bytes",
        );
    });
});

function plugin(root: string): RegisteredPlugin {
    return {
        directory: root,
        entryPath: join(root, "index.ts"),
        folderName: "usage",
        iconPath: join(root, "icon.png"),
        manifest: {
            apps: [
                {
                    id: "usage",
                    page: "index.html",
                    root: "app",
                    sidebar: { label: "Usage", order: 10 },
                    title: "Usage",
                },
            ],
            description: "Usage",
            entry: "index.ts",
            icon: "icon.png",
            name: "Usage",
            version: "0.0.0",
        },
        manifestPath: join(root, "happy.plugin.json"),
    };
}

async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "rig-app-snapshot-"));
    roots.push(root);
    return root;
}
