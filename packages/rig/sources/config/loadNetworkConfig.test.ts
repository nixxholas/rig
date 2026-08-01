import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getHappyConfigDirectory } from "./getHappyConfigDirectory.js";
import { loadNetworkConfig, loadNetworkConfigForProject } from "./loadNetworkConfig.js";
import { parseConfigToml } from "./parseConfigToml.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("loadNetworkConfig", () => {
    it("falls back to happy.toml but prefers rig.toml", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-network-fallback-"));
        temporaryDirectories.push(root);
        const workspace = join(root, "workspace");
        await mkdir(workspace, { recursive: true });
        await writeFile(
            join(workspace, "happy.toml"),
            '[network]\nallowed_domains = ["happy.example"]\n',
        );

        await expect(loadNetworkConfig({ cwd: workspace, homeDirectory: root })).resolves.toEqual({
            allowedDomains: ["happy.example"],
        });

        await writeFile(
            join(workspace, "rig.toml"),
            '[network]\nallowed_domains = ["rig.example"]\n',
        );
        await expect(loadNetworkConfig({ cwd: workspace, homeDirectory: root })).resolves.toEqual({
            allowedDomains: ["rig.example"],
        });
    });

    it("uses project policy over global policy and ignores runtime settings", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-network-config-"));
        temporaryDirectories.push(root);
        const homeDirectory = join(root, "home");
        const workspace = join(root, "workspace");
        const configDirectory = getHappyConfigDirectory({}, homeDirectory);
        const rigHome = join(homeDirectory, ".happy", "rig");
        await Promise.all([
            mkdir(configDirectory, { recursive: true }),
            mkdir(rigHome, { recursive: true }),
            mkdir(workspace, { recursive: true }),
        ]);
        await writeFile(
            join(configDirectory, "happy.toml"),
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
            allowedDomains: ["project.example"],
        });
    });

    it("combines host machine settings with a Docker project config", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-docker-network-config-"));
        temporaryDirectories.push(root);
        const configDirectory = getHappyConfigDirectory({}, root);
        await mkdir(configDirectory, { recursive: true });
        await writeFile(
            join(configDirectory, "happy.toml"),
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

    it("preserves global and project denies while ignoring runtime network values", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-network-denies-"));
        temporaryDirectories.push(root);
        const homeDirectory = join(root, "home");
        const workspace = join(root, "workspace");
        const configDirectory = getHappyConfigDirectory({}, homeDirectory);
        const rigHome = join(homeDirectory, ".happy", "rig");
        await Promise.all([
            mkdir(configDirectory, { recursive: true }),
            mkdir(rigHome, { recursive: true }),
            mkdir(workspace, { recursive: true }),
        ]);
        await writeFile(
            join(configDirectory, "happy.toml"),
            [
                "[network]",
                'allowed_domains = ["global.example"]',
                'denied_domains = ["global-blocked.example"]',
            ].join("\n"),
        );
        await writeFile(
            join(workspace, "rig.toml"),
            [
                "[network]",
                'allowed_domains = ["project.example"]',
                'denied_domains = ["project-blocked.example"]',
            ].join("\n"),
        );
        await writeFile(
            join(rigHome, "runtime.toml"),
            [
                "[network]",
                'allowed_domains = ["runtime.example"]',
                'denied_domains = ["runtime-blocked.example", "global-blocked.example"]',
            ].join("\n"),
        );

        await expect(loadNetworkConfig({ cwd: workspace, homeDirectory })).resolves.toEqual({
            allowedDomains: ["project.example"],
            deniedDomains: ["global-blocked.example", "project-blocked.example"],
        });
    });
});
