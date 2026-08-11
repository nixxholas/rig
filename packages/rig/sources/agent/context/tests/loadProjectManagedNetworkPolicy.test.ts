import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadProjectManagedNetworkPolicy } from "../loadProjectManagedNetworkPolicy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("loadProjectManagedNetworkPolicy", () => {
    it("reads the current root rig.toml on every call", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "rig-project-network-"));
        temporaryDirectories.push(workspace);

        await writeFile(
            join(workspace, "rig.toml"),
            [
                "[network]",
                "allow_local_binding = true",
                'allowed_domains = ["coderabbit.ai", "*.coderabbit.ai"]',
                'denied_domains = ["blocked.example"]',
                "allowed_ports = [443, 8443]",
                "allowed_loopback_ports = [443]",
            ].join("\n"),
        );

        await expect(loadProjectManagedNetworkPolicy(workspace)).resolves.toEqual({
            allowLocalBinding: true,
            allowedDomains: [
                { domain: "coderabbit.ai", ports: [443, 8443] },
                { domain: "*.coderabbit.ai", ports: [443, 8443] },
            ],
            allowedLoopbackPorts: [443],
            deniedDomains: [{ domain: "blocked.example" }],
        });

        await writeFile(
            join(workspace, "rig.toml"),
            ["[network]", 'allowed_domains = ["api.example.com"]'].join("\n"),
        );

        await expect(loadProjectManagedNetworkPolicy(workspace)).resolves.toEqual({
            allowedDomains: [{ domain: "api.example.com", ports: [443] }],
        });
    });
});
