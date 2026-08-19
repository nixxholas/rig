import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceFileSearchModule } from "../../sources/workspaceFileSearch/index.js";

const directories = new Set<string>();
const modules = new Set<WorkspaceFileSearchModule>();

afterEach(async () => {
    for (const module of modules) module.close();
    modules.clear();
    await Promise.all(
        [...directories].map(
            async (directory) =>
                await rm(directory, {
                    force: true,
                    recursive: true,
                }),
        ),
    );
    directories.clear();
});

describe("WorkspaceFileSearchModule", () => {
    it("fuzzy-searches relative file paths", async () => {
        const root = await workspace();
        await mkdir(join(root, "sources", "components"), { recursive: true });
        await writeFile(join(root, "sources", "components", "ChatComposer.tsx"), "export {};");
        await writeFile(join(root, "README.md"), "Rig");
        const search = new WorkspaceFileSearchModule();
        modules.add(search);

        const result = await search.search(root, { query: "chtcomp" });

        expect(result.files).toContainEqual({
            fileName: "ChatComposer.tsx",
            path: "sources/components/ChatComposer.tsx",
        });
    });

    it("lists ranked workspace files for an empty query", async () => {
        const root = await workspace();
        await mkdir(join(root, "src"), { recursive: true });
        await writeFile(join(root, "src", "mention-target.ts"), "export {};");
        const search = new WorkspaceFileSearchModule();
        modules.add(search);

        const result = await search.search(root, { query: "" });

        expect(result.files).toContainEqual({
            fileName: "mention-target.ts",
            path: "src/mention-target.ts",
        });
    });
});

async function workspace(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "happy-workspace-file-search-"));
    directories.add(directory);
    return directory;
}
