import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadNetworkConfig, loadNetworkConfigForProject } from "./loadNetworkConfig.js";
import { parseConfigToml } from "./parseConfigToml.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("loadNetworkConfig", () => {
    it("uses the normal global, project, and runtime precedence", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-network-config-"));
        temporaryDirectories.push(root);
        const homeDirectory = join(root, "home");
        const workspace = join(root, "workspace");
        const rigHome = join(homeDirectory, ".rig");
        await Promise.all([
            mkdir(rigHome, { recursive: true }),
            mkdir(workspace, { recursive: true }),
        ]);
        await writeFile(
            join(rigHome, "config.toml"),
            '[network]\nallowed_domains = ["global.example"]\n',
        );
        await writeFile(
            join(workspace, "rig.toml"),
            '[network]\nallowed_domains = ["project.example"]\n',
        );

        await expect(loadNetworkConfig({ cwd: workspace, homeDirectory })).resolves.toEqual({
            allowedDomains: ["project.example"],
        });

        await writeFile(
            join(rigHome, "runtime.toml"),
            '[network]\nallowed_domains = ["runtime.example"]\n',
        );
        await expect(loadNetworkConfig({ cwd: workspace, homeDirectory })).resolves.toEqual({
            allowedDomains: ["runtime.example"],
        });
    });

    it("combines host machine settings with a Docker project config", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-docker-network-config-"));
        temporaryDirectories.push(root);
        const rigHome = join(root, ".rig");
        await mkdir(rigHome, { recursive: true });
        await writeFile(
            join(rigHome, "config.toml"),
            '[network]\nallowed_domains = ["global.example"]\n',
        );
        const project = parseConfigToml(
            '[network]\nallowed_domains = ["container-project.example"]\n',
        );

        await expect(
            loadNetworkConfigForProject(project, { homeDirectory: root }),
        ).resolves.toEqual({
            allowedDomains: ["container-project.example"],
        });
    });
});
