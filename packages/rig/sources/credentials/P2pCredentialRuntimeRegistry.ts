import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ConfigProvider, ConfigProviders } from "../config/types.js";
import { createModelCatalog } from "../model-catalog/createModelCatalog.js";
import type { P2pTrustedPeer } from "../p2p/P2pPeer.js";
import type { ModelCatalog } from "../protocol/index.js";
import type { ProvisionedProvider } from "../protocol/P2pCredentialProtocol.js";
import type { P2pCredentialStore } from "./P2pCredentialStore.js";
import {
    buildOwnerProviderScope,
    type OwnerProviderScope,
    type ProviderCredentialSource,
} from "./buildOwnerProviderScope.js";

export interface P2pCredentialRuntimeRegistryOptions {
    localCatalog: ModelCatalog;
    localInstanceId: string;
    localName: () => string;
    localProviders: ConfigProviders;
    peers: () => readonly P2pTrustedPeer[];
    runtimeDirectory: string;
    store: P2pCredentialStore;
}

/**
 * Builds isolated executable provider maps for credentials owned by each Rig.
 *
 * Uploaded native auth files live under Rig's private runtime directory and are never merged into
 * the receiving machine's Codex/Grok homes. A session receives one immutable owner ID and resolves
 * both its catalog and executor providers through that owner.
 */
export class P2pCredentialRuntimeRegistry {
    readonly #options: P2pCredentialRuntimeRegistryOptions;
    #revision: string | undefined;
    #sources: readonly ProviderCredentialSource[] = [];

    constructor(options: P2pCredentialRuntimeRegistryOptions) {
        this.#options = options;
        mkdirSync(options.runtimeDirectory, { mode: 0o700, recursive: true });
        chmodSync(options.runtimeDirectory, 0o700);
        this.refresh();
    }

    refresh(): boolean {
        const snapshots = this.#options.store.listAll();
        const retainedCredentialDirectories = new Set<string>();
        for (const [ownerInstanceId, snapshot] of snapshots) {
            for (const provider of snapshot) {
                if (
                    provider.material !== undefined &&
                    "accessToken" in provider.material &&
                    (provider.material.type === "codex" || provider.material.type === "grok")
                ) {
                    retainedCredentialDirectories.add(
                        join(
                            ownerInstanceId,
                            Buffer.from(provider.providerId).toString("base64url"),
                        ),
                    );
                }
            }
        }
        this.#removeStaleCredentialDirectories(retainedCredentialDirectories);
        const peers = new Map(
            this.#options.peers().map((peer) => [peer.instanceId, peer] as const),
        );
        const sources: ProviderCredentialSource[] = [
            {
                catalog: this.#options.localCatalog,
                instanceId: this.#options.localInstanceId,
                name: this.#options.localName(),
                providers: this.#options.localProviders,
                visibility: Object.fromEntries(
                    Object.entries(this.#options.localProviders).map(([providerId, provider]) => [
                        providerId,
                        provider.p2pShare === "shared"
                            ? ("shared" as const)
                            : ("owner_only" as const),
                    ]),
                ),
            },
        ];
        for (const [ownerInstanceId, snapshot] of snapshots) {
            const peer = peers.get(ownerInstanceId);
            if (peer === undefined) continue;
            const providers = this.#materialize(ownerInstanceId, snapshot);
            if (Object.keys(providers).length === 0) continue;
            let catalog: ModelCatalog;
            try {
                catalog = createModelCatalog({
                    cwd: this.#options.runtimeDirectory,
                    env: {},
                    providers,
                });
            } catch {
                continue;
            }
            sources.push({
                catalog,
                instanceId: ownerInstanceId,
                name: peer.name,
                providers,
                visibility: Object.fromEntries(
                    snapshot.map((provider) => [provider.providerId, provider.visibility]),
                ),
            });
        }
        this.#sources = sources;
        const revision = createHash("sha256")
            .update(
                JSON.stringify({
                    peers: this.#options
                        .peers()
                        .map((peer) => ({ instanceId: peer.instanceId, name: peer.name })),
                    snapshots: [...snapshots],
                }),
            )
            .digest("hex");
        const changed = revision !== this.#revision;
        this.#revision = revision;
        return changed;
    }

    scope(ownerInstanceId: string): OwnerProviderScope {
        return buildOwnerProviderScope({
            localInstanceId: this.#options.localInstanceId,
            ownerInstanceId,
            sources: this.#sources,
        });
    }

    catalog(ownerInstanceId: string): ModelCatalog {
        return this.scope(ownerInstanceId).catalog;
    }

    providers(ownerInstanceId: string): ConfigProviders {
        return this.scope(ownerInstanceId).providers;
    }

    #materialize(
        ownerInstanceId: string,
        snapshot: readonly ProvisionedProvider[],
    ): ConfigProviders {
        return Object.fromEntries(
            snapshot.flatMap((provider) => {
                const config = materializedProvider(
                    provider,
                    ownerInstanceId,
                    this.#options.runtimeDirectory,
                );
                return config === undefined ? [] : [[provider.providerId, config] as const];
            }),
        );
    }

    #removeStaleCredentialDirectories(retained: ReadonlySet<string>): void {
        for (const owner of readdirSync(this.#options.runtimeDirectory, {
            withFileTypes: true,
        })) {
            const ownerPath = join(this.#options.runtimeDirectory, owner.name);
            if (!owner.isDirectory()) {
                rmSync(ownerPath, { force: true, recursive: true });
                continue;
            }
            for (const provider of readdirSync(ownerPath, { withFileTypes: true })) {
                const relative = join(owner.name, provider.name);
                if (!provider.isDirectory() || !retained.has(relative)) {
                    rmSync(join(ownerPath, provider.name), { force: true, recursive: true });
                }
            }
            if (readdirSync(ownerPath).length === 0) {
                rmSync(ownerPath, { force: true, recursive: true });
            }
        }
    }
}

function materializedProvider(
    provider: ProvisionedProvider,
    ownerInstanceId: string,
    runtimeDirectory: string,
): ConfigProvider | undefined {
    const material = provider.material;
    if (material === undefined || material.type !== provider.config.type) return undefined;
    const common = {
        credentialIsolation: true as const,
        enabled: provider.config.enabled,
        ...(provider.config.excludeModels === undefined
            ? {}
            : { excludeModels: provider.config.excludeModels }),
        ...(provider.config.includeModels === undefined
            ? {}
            : { includeModels: provider.config.includeModels }),
        p2pShare: "disabled" as const,
    };
    if (provider.config.type === "codex") {
        if (material.type !== "codex") return undefined;
        const credential =
            "apiKey" in material
                ? { apiKey: material.apiKey }
                : {
                      authFile: materializeAuthFile(
                          runtimeDirectory,
                          ownerInstanceId,
                          provider.providerId,
                          "codex",
                          JSON.stringify({
                              auth_mode: "chatgpt",
                              OPENAI_API_KEY: null,
                              tokens: {
                                  access_token: material.accessToken,
                                  ...(material.accountId === undefined
                                      ? {}
                                      : { account_id: material.accountId }),
                              },
                          }),
                      ),
                  };
        return {
            ...common,
            ...credential,
            ...(provider.config.baseUrl === undefined ? {} : { baseUrl: provider.config.baseUrl }),
            ...(provider.config.transport === undefined
                ? {}
                : { transport: provider.config.transport }),
            type: "codex",
        };
    }
    if (provider.config.type === "grok") {
        if (material.type !== "grok") return undefined;
        const credential =
            "apiKey" in material
                ? { apiKey: material.apiKey }
                : {
                      authFile: materializeAuthFile(
                          runtimeDirectory,
                          ownerInstanceId,
                          provider.providerId,
                          "grok",
                          JSON.stringify({
                              "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
                                  auth_mode: "external",
                                  key: material.accessToken,
                                  ...(material.createdAt === undefined
                                      ? {}
                                      : { create_time: material.createdAt }),
                                  ...(material.expiresAt === undefined
                                      ? {}
                                      : { expires_at: material.expiresAt }),
                              },
                          }),
                      ),
                  };
        return {
            ...common,
            ...credential,
            ...(provider.config.baseUrl === undefined ? {} : { baseUrl: provider.config.baseUrl }),
            type: "grok",
        };
    }
    if (provider.config.type === "claude") {
        if (material.type !== "claude") return undefined;
        const credential =
            "apiKey" in material
                ? { apiKey: material.apiKey }
                : "authToken" in material
                  ? { authToken: material.authToken }
                  : { oauthToken: material.oauthToken };
        return { ...common, ...credential, type: "claude" };
    }
    if (material.type !== "bedrock") return undefined;
    return {
        ...common,
        bearerToken: material.bearerToken,
        ...(provider.config.modelOverrides === undefined
            ? {}
            : { modelOverrides: provider.config.modelOverrides }),
        ...(provider.config.region === undefined ? {} : { region: provider.config.region }),
        ...(provider.config.searchModelId === undefined
            ? {}
            : { searchModelId: provider.config.searchModelId }),
        type: "bedrock",
    };
}

function materializeAuthFile(
    runtimeDirectory: string,
    ownerInstanceId: string,
    providerId: string,
    vendor: "codex" | "grok",
    contents: string,
    filename = `${vendor}-auth.json`,
): string {
    const safeProviderId = Buffer.from(providerId).toString("base64url");
    const directory = join(runtimeDirectory, ownerInstanceId, safeProviderId);
    const path = join(directory, filename);
    mkdirSync(directory, { mode: 0o700, recursive: true });
    chmodSync(directory, 0o700);
    // This is an owner-issued access-token lease, never a refreshable credential. Reinstall it on
    // every registry refresh so a provider cannot retain locally mutated authentication state.
    writeFileSync(path, contents, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
}
