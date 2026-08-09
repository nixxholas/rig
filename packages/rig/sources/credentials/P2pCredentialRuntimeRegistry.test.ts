import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ConfigProviders } from "../config/types.js";
import { createModelCatalog } from "../model-catalog/createModelCatalog.js";
import type { P2pCredentialStore } from "./P2pCredentialStore.js";
import { P2pCredentialRuntimeRegistry } from "./P2pCredentialRuntimeRegistry.js";

const localInstanceId = "alocalinstance00000000001";
const ownerInstanceId = "aremoteinstance0000000001";
const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("P2pCredentialRuntimeRegistry", () => {
    it("keeps the remote owner's IDs authoritative and attributes colliding local extras", async () => {
        const runtimeDirectory = mkdtempSync(join(tmpdir(), "rig-credential-runtime-"));
        directories.push(runtimeDirectory);
        const localProviders: ConfigProviders = {
            codex: {
                apiKey: "local",
                enabled: true,
                p2pShare: "shared",
                type: "codex",
            },
        };
        const store = {
            listAll: () =>
                new Map([
                    [
                        ownerInstanceId,
                        [
                            {
                                config: { enabled: true, type: "codex" as const },
                                material: { apiKey: "remote", type: "codex" as const },
                                providerId: "codex",
                                visibility: "owner_only" as const,
                            },
                        ],
                    ],
                ]),
        } as unknown as P2pCredentialStore;
        const registry = await P2pCredentialRuntimeRegistry.open({
            localCatalog: createModelCatalog({ providers: localProviders }),
            localInstanceId,
            localName: () => "Build Rig",
            localProviders,
            peers: () => [
                {
                    bindings: [],
                    connections: {},
                    instanceId: ownerInstanceId,
                    name: "Steve's Rig",
                    publicKey: "A".repeat(43),
                },
            ],
            runtimeDirectory,
            store,
        });

        const scope = registry.scope(ownerInstanceId);
        expect(scope.catalog.providers.map((provider) => provider.providerId)).toEqual([
            "codex",
            `codex@${localInstanceId}`,
        ]);
        expect(scope.catalog.providers[0]?.credential).toMatchObject({
            ownerInstanceId,
            relation: "owner",
            sourceProviderId: "codex",
        });
        expect(scope.providers.codex).toMatchObject({ apiKey: "remote" });
    });

    it("materializes only an access-token lease and removes it after revocation", async () => {
        const runtimeDirectory = mkdtempSync(join(tmpdir(), "rig-credential-runtime-"));
        directories.push(runtimeDirectory);
        let snapshots = new Map([
            [
                ownerInstanceId,
                [
                    {
                        config: { enabled: true, type: "codex" as const },
                        material: {
                            accessToken: "remote-access-token",
                            accountId: "account-1",
                            type: "codex" as const,
                        },
                        providerId: "codex",
                        visibility: "owner_only" as const,
                    },
                ],
            ],
        ]);
        const store = {
            listAll: () => snapshots,
        } as unknown as P2pCredentialStore;
        const registry = await P2pCredentialRuntimeRegistry.open({
            localCatalog: createModelCatalog({
                providers: { localCodex: { apiKey: "local", enabled: true, type: "codex" } },
            }),
            localInstanceId,
            localName: () => "Build Rig",
            localProviders: {
                localCodex: { apiKey: "local", enabled: true, type: "codex" },
            },
            peers: () => [
                {
                    bindings: [],
                    connections: {},
                    instanceId: ownerInstanceId,
                    name: "Steve's Rig",
                    publicKey: "A".repeat(43),
                },
            ],
            runtimeDirectory,
            store,
        });

        const provider = registry.providers(ownerInstanceId).codex;
        if (provider?.type !== "codex") throw new Error("Expected the provisioned Codex provider.");
        const authFile = provider.authFile;
        expect(authFile).toBeTypeOf("string");
        expect(JSON.parse(readFileSync(authFile!, "utf8"))).toEqual({
            auth_mode: "chatgpt",
            OPENAI_API_KEY: null,
            tokens: {
                access_token: "remote-access-token",
                account_id: "account-1",
            },
        });
        expect(readFileSync(authFile!, "utf8")).not.toContain("refresh");

        snapshots = new Map();
        await registry.refresh();
        expect(existsSync(authFile!)).toBe(false);
    });
});
