import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildExtension } from "../buildExtension.js";
import { discoverExtensions } from "../discoverExtensions.js";
import { ExtensionBuildError } from "../ExtensionBuildError.js";
import { ExtensionLog } from "../ExtensionLog.js";
import { getExtensionsDirectory } from "../getExtensionsDirectory.js";
import { readExtensionManifest } from "../readExtensionManifest.js";

const require = createRequire(import.meta.url);
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("extensions", () => {
    it("uses a user-visible extensions directory with an absolute override", () => {
        expect(getExtensionsDirectory({}, "/Users/steve", "darwin")).toBe(
            "/Users/steve/Happy/Extensions",
        );
        expect(getExtensionsDirectory({}, "/home/steve", "linux")).toBe(
            "/home/steve/happy/extensions",
        );
        expect(
            getExtensionsDirectory(
                { RIG_EXTENSIONS_DIRECTORY: "/srv/rig-extensions" },
                "/home/steve",
                "linux",
            ),
        ).toBe("/srv/rig-extensions");
        expect(
            getExtensionsDirectory({ RIG_HOME: "/tmp/isolated-home/.rig" }, "/home/steve", "linux"),
        ).toBe("/tmp/isolated-home/extensions");
        expect(() =>
            getExtensionsDirectory(
                { RIG_EXTENSIONS_DIRECTORY: "relative" },
                "/home/steve",
                "linux",
            ),
        ).toThrow("must be an absolute path");
    });

    it("registers only folders with a TypeBox-valid manifest and PNG icon", async () => {
        const root = await temporaryDirectory();
        await createExtensionFixture(join(root, "clock"), {
            source: 'console.log("tick");\n',
        });
        await createExtensionFixture(join(root, "broken"), {
            manifest: {
                description: "Has an unexpected field",
                entry: "index.ts",
                icon: "icon.png",
                name: "Broken",
                permission: "all",
            },
        });

        const discovery = await discoverExtensions(root);
        expect(discovery.extensions.map((extension) => extension.manifest.name)).toEqual(["Clock"]);
        expect(discovery.failures).toHaveLength(1);
        expect(discovery.failures[0]?.error).toContain("rig.plugin.json is invalid");
    });

    it("rejects manifest assets that escape through symbolic links", async () => {
        const root = await temporaryDirectory();
        const directory = join(root, "linked");
        const externalEntry = join(root, "outside.ts");
        await createExtensionFixture(directory, {});
        await writeFile(externalEntry, 'console.log("outside");\n');
        await rm(join(directory, "index.ts"));
        await symlink(externalEntry, join(directory, "index.ts"));

        await expect(readExtensionManifest(directory)).rejects.toThrow(
            "The extension entry must be a file.",
        );
    });

    it("keeps captured extension output within its configured bound", async () => {
        const root = await temporaryDirectory();
        const logPath = join(root, "extension.log");
        const log = new ExtensionLog({ maximumBytes: 64, path: logPath });
        log.append("stdout", Buffer.alloc(1024, "x"));
        await log.close();

        await expect(readFile(logPath)).resolves.toHaveLength(64);
    });

    it("builds with TypeScript 7 against Rig's SDK and rejects incompatible calls", async () => {
        const root = await temporaryDirectory();
        const directory = join(root, "builder");
        await createExtensionFixture(directory, {
            source: [
                'import { rig } from "@slopus/plugins";',
                "const projects = await rig.projects.list();",
                'console.log(projects.map((project) => project.name).join(","));',
                "",
            ].join("\n"),
        });
        const extension = await readExtensionManifest(directory);
        const sdkModuleDirectory = dirname(require.resolve("@slopus/plugins"));
        const built = await buildExtension(extension, { sdkModuleDirectory });
        await expect(readFile(built.builtEntryPath, "utf8")).resolves.toContain(
            'from "@slopus/plugins"',
        );

        await writeFile(
            extension.entryPath,
            [
                'import { rig } from "@slopus/plugins";',
                'await rig.workspaces.create({ name: 42, projectId: "project" });',
                "",
            ].join("\n"),
        );
        await expect(buildExtension(extension, { sdkModuleDirectory })).rejects.toBeInstanceOf(
            ExtensionBuildError,
        );
    });
});

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "rig-extensions-"));
    temporaryDirectories.push(directory);
    return directory;
}

async function createExtensionFixture(
    directory: string,
    options: {
        manifest?: Record<string, unknown>;
        source?: string;
    },
): Promise<void> {
    await mkdir(directory, { recursive: true });
    await Promise.all([
        writeFile(
            join(directory, "rig.plugin.json"),
            `${JSON.stringify(
                options.manifest ?? {
                    description: "A small clock.",
                    entry: "index.ts",
                    icon: "icon.png",
                    name: "Clock",
                },
                null,
                2,
            )}\n`,
        ),
        writeFile(join(directory, "icon.png"), PNG_SIGNATURE),
        writeFile(join(directory, "index.ts"), options.source ?? 'console.log("ready");\n'),
    ]);
}
