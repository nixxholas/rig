import {
    AgentProviders,
    type AgentModel,
    type AgentPermissionMode,
} from "@slopus/happy-agent-base";
import {
    AnthropicProvider,
    BedrockBearerTokenCredential,
    ClaudeApiKeyCredential,
    ClaudeAuthTokenCredential,
    ClaudeCodeCredential,
    ClaudeOAuthCredential,
    CodexApiKeyCredential,
    CodexSessionCredential,
    CodexProvider,
    GrokApiKeyCredential,
    GrokProvider,
    GrokSessionCredential,
    loadCodexCredential,
} from "@slopus/happy-providers";
import type { HappyAgentConfigValues, HappyAgentConfiguration } from "@slopus/happy-agent-modules";

import type { HappyAgentIntegrations } from "./modules/agent/loadHappyAgent.js";

export interface VanillaHappyAgentConfiguration {
    readonly integrations: HappyAgentIntegrations;
    readonly models: readonly AgentModel[];
    readonly provider: string;
    readonly providers: AgentProviders;
}

export interface EffectiveAgentSelection {
    readonly provider: string;
    readonly model: string;
    readonly effort: AgentModel["effortLevels"][number];
    readonly serviceTier?: "priority";
    readonly permissionMode: AgentPermissionMode;
}

export interface AgentSelectionOverrides {
    readonly model?: string;
    readonly provider?: string;
    readonly effort?: string;
    readonly serviceTier?: "fast" | "priority" | null;
}

type AgentSelectionDefaults = Omit<EffectiveAgentSelection, "effort" | "serviceTier"> & {
    readonly effort?: string;
    readonly serviceTier?: "fast" | "priority";
};

/** The standard Happy Agent composition used whenever a host supplies only its two home paths. */
export function createVanillaHappyAgentConfiguration(
    configuration?: HappyAgentConfiguration,
    options: { readonly filterModels?: boolean } = {},
): VanillaHappyAgentConfiguration {
    validateCredentialIsolation(configuration);
    return {
        integrations: createVanillaIntegrations(configuration),
        models:
            options.filterModels === false
                ? VANILLA_MODELS
                : filterConfiguredModels(configuredCatalogModels(configuration), configuration),
        provider: configuration?.values.defaults.providerId ?? "codex",
        providers: createVanillaProviders(configuration),
    };
}

export function resolveEffectiveAgentSelection(
    configuration: HappyAgentConfiguration,
    models: readonly AgentModel[],
    provider: string,
    overrides: AgentSelectionOverrides & {
        readonly fallbackToProviderRoute?: boolean;
    } = {},
): EffectiveAgentSelection {
    const { fallbackToProviderRoute, ...selectionOverrides } = overrides;
    return resolveAgentSelection(
        {
            model: configuration.values.defaults.modelId,
            permissionMode: configuration.values.defaults.permissionMode,
            provider,
            ...(configuration.values.defaults.effort === undefined
                ? {}
                : { effort: configuration.values.defaults.effort }),
            ...(configuration.values.defaults.serviceTier === undefined
                ? {}
                : { serviceTier: configuration.values.defaults.serviceTier }),
        },
        models,
        selectionOverrides,
        fallbackToProviderRoute === undefined ? {} : { fallbackToProviderRoute },
    );
}

export function resolveAgentSelection(
    defaults: AgentSelectionDefaults,
    models: readonly AgentModel[],
    overrides: AgentSelectionOverrides = {},
    options: { readonly fallbackToProviderRoute?: boolean } = {},
): EffectiveAgentSelection {
    const providerExplicit = overrides.provider !== undefined;
    const modelExplicit = overrides.model !== undefined;
    const requestedProvider = overrides.provider ?? defaults.provider;
    const requestedModel = overrides.model ?? defaults.model;
    let selected =
        models.find(
            (candidate) =>
                candidate.id === requestedModel && candidate.providerId === requestedProvider,
        ) ??
        (modelExplicit && !providerExplicit
            ? (() => {
                  const candidates = models.filter((candidate) => candidate.id === requestedModel);
                  return candidates.length === 1 ? candidates[0] : undefined;
              })()
            : undefined);
    if (
        selected === undefined &&
        !modelExplicit &&
        (providerExplicit || options.fallbackToProviderRoute === true)
    ) {
        selected = models.find((candidate) => candidate.providerId === requestedProvider);
    }
    if (selected === undefined) {
        const servedBy = models
            .filter((candidate) => candidate.id === requestedModel)
            .map((candidate) => candidate.providerId);
        throw new Error(
            servedBy.length === 0
                ? `Model "${requestedModel}" is not available in the final model catalog.`
                : `Model "${requestedModel}" is not served by provider "${requestedProvider}".`,
        );
    }

    const effort = overrides.effort ?? defaults.effort ?? selected.defaultEffort;
    if (!selected.effortLevels.includes(effort as AgentModel["effortLevels"][number])) {
        throw new Error(
            `Effort "${effort}" is not supported by model "${selected.id}" for provider "${selected.providerId}".`,
        );
    }
    const requestedTier =
        overrides.serviceTier === undefined ? defaults.serviceTier : overrides.serviceTier;
    const serviceTier =
        requestedTier === "fast" || requestedTier === "priority" ? "priority" : undefined;
    if (serviceTier !== undefined && selected.serviceTiers?.includes(serviceTier) !== true) {
        throw new Error(
            `Service tier "${serviceTier}" is not supported by model "${selected.id}" for provider "${selected.providerId}".`,
        );
    }
    return Object.freeze({
        effort: effort as AgentModel["effortLevels"][number],
        model: selected.id,
        permissionMode: defaults.permissionMode,
        provider: selected.providerId,
        ...(serviceTier === undefined ? {} : { serviceTier }),
    });
}

export function applyEffectiveAgentSelection(
    models: readonly AgentModel[],
    selection: EffectiveAgentSelection,
): readonly AgentModel[] {
    const selected = models.find(
        (candidate) =>
            candidate.id === selection.model && candidate.providerId === selection.provider,
    );
    if (selected === undefined) {
        throw new Error(
            `Effective model "${selection.model}" is not served by provider "${selection.provider}".`,
        );
    }
    const withSelection = {
        ...selected,
        defaultEffort: selection.effort as AgentModel["defaultEffort"],
    };
    return [
        withSelection,
        ...models.filter(
            (candidate) =>
                candidate.id !== selection.model || candidate.providerId !== selection.provider,
        ),
    ];
}

const VANILLA_MODELS: readonly AgentModel[] = [
    model(
        "codex",
        "openai/gpt-5.6-sol",
        "GPT-5.6 Sol",
        ["low", "medium", "high", "xhigh", "max"],
        "medium",
        ["priority"],
    ),
    model(
        "codex",
        "openai/gpt-5.6-terra",
        "GPT-5.6 Terra",
        ["off", "low", "medium", "high", "xhigh", "max"],
        "medium",
        ["priority"],
    ),
    model(
        "codex",
        "openai/gpt-5.6-luna",
        "GPT-5.6 Luna",
        ["off", "low", "medium", "high", "xhigh", "max"],
        "medium",
        ["priority"],
    ),
    model("claude", "anthropic/opus-5", "Opus 5 1M"),
    model("claude", "anthropic/sonnet-5", "Sonnet 5"),
    model("claude", "anthropic/fable-5", "Fable 5"),
    model("claude", "anthropic/opus-4-8", "Opus 4.8 1M"),
    model("grok", "xai/grok-build", "Grok Build", ["medium"]),
    model("grok", "xai/grok-4.5", "Grok 4.5", ["low", "medium", "high"], "high"),
    model("grok", "xai/grok-composer-2.5-fast", "Composer 2.5", ["off"], "off"),
];

const BEDROCK_MODELS: readonly AgentModel[] = [
    ...VANILLA_MODELS.filter((candidate) => candidate.providerId !== "grok").map((candidate) => {
        const { serviceTiers: _serviceTiers, ...withoutServiceTiers } = candidate;
        return { ...withoutServiceTiers, providerId: "bedrock" };
    }),
    model("bedrock", "openai/gpt-5.4", "GPT-5.4", ["off", "low", "medium", "high", "xhigh"]),
];

function configuredCatalogModels(configuration?: HappyAgentConfiguration): readonly AgentModel[] {
    if (configuration === undefined) return VANILLA_MODELS;
    const providers = configuration.values.providers;
    const models: AgentModel[] = [];
    for (const [id, provider] of Object.entries(providers)) {
        const source =
            provider.type === "bedrock"
                ? BEDROCK_MODELS
                : VANILLA_MODELS.filter((candidate) => candidate.providerId === provider.type);
        for (const candidate of source) {
            models.push({ ...candidate, providerId: id });
        }
    }
    return models;
}

export function filterConfiguredModels(
    models: readonly AgentModel[],
    configuration?: HappyAgentConfiguration,
): readonly AgentModel[] {
    if (configuration === undefined) return models;
    const values = configuration.values;
    const filtered = models.filter((candidate) => {
        const provider = values.providers[candidate.providerId];
        if (provider?.enabled === false) return false;
        if (
            provider?.includeModels !== undefined &&
            !provider.includeModels.includes(candidate.id)
        ) {
            return false;
        }
        if (provider?.excludeModels?.includes(candidate.id) === true) return false;
        return true;
    });
    const defaultModelId = values.defaults.modelId;
    if (!filtered.some((candidate) => candidate.id === defaultModelId)) {
        throw new Error(
            `Configured default model "${defaultModelId}" is not available in the enabled model catalog.`,
        );
    }
    const defaultProviderId = values.defaults.providerId ?? "codex";
    const defaultModel =
        filtered.find(
            (candidate) =>
                candidate.id === defaultModelId && candidate.providerId === defaultProviderId,
        ) ?? filtered.find((candidate) => candidate.id === defaultModelId);
    if (
        values.defaults.providerId !== undefined &&
        defaultModel !== undefined &&
        defaultModel.providerId !== values.defaults.providerId
    ) {
        throw new Error(
            `Configured default model "${defaultModel.id}" is not served by configured default provider "${values.defaults.providerId}".`,
        );
    }
    const configuredEffort = values.defaults.effort;
    if (
        defaultModel !== undefined &&
        configuredEffort !== undefined &&
        !defaultModel.effortLevels.includes(configuredEffort as AgentModel["effortLevels"][number])
    ) {
        throw new Error(
            `Configured effort "${configuredEffort}" is not supported by model "${defaultModel.id}".`,
        );
    }
    const withDefaultEffort =
        defaultModel === undefined || configuredEffort === undefined
            ? defaultModel
            : {
                  ...defaultModel,
                  defaultEffort: configuredEffort as AgentModel["defaultEffort"],
              };
    const ordered = filtered.filter(
        (candidate) =>
            candidate.id !== defaultModelId || candidate.providerId !== defaultModel?.providerId,
    );
    return withDefaultEffort === undefined ? ordered : [withDefaultEffort, ...ordered];
}

function createVanillaProviders(configuration?: HappyAgentConfiguration): AgentProviders {
    const providers = new AgentProviders();
    const retryLimit = configuration?.values.settings.inferenceMaxRetries;
    const configuredProviders = configuration?.values.providers ?? {};
    for (const [id, provider] of Object.entries(configuredProviders)) {
        if (provider.enabled === false) continue;
        providers.add(
            id,
            async ({ model: selectedModel }) =>
                await createConfiguredProvider(id, provider, selectedModel, retryLimit),
            provider.type,
        );
    }
    if (configuration === undefined) {
        providers.add(
            "codex",
            async () =>
                await createConfiguredProvider(
                    "codex",
                    {
                        enabled: true,
                        type: "codex",
                    },
                    undefined,
                    undefined,
                ),
            "codex",
        );
        providers.add(
            "claude",
            async () =>
                await createConfiguredProvider(
                    "claude",
                    {
                        enabled: true,
                        type: "claude",
                    },
                    undefined,
                    undefined,
                ),
            "claude",
        );
        providers.add(
            "grok",
            async () =>
                await createConfiguredProvider(
                    "grok",
                    {
                        enabled: true,
                        type: "grok",
                    },
                    undefined,
                    undefined,
                ),
            "grok",
        );
    }
    return providers;
}

async function createConfiguredProvider(
    id: string,
    provider: HappyAgentConfigValues["providers"][string],
    selectedModel: string | undefined,
    retryLimit: number | undefined,
): Promise<import("@slopus/happy-providers").BaseProvider> {
    if (provider.type === "codex") {
        const credential =
            provider.credentialIsolation === true
                ? provider.apiKey === undefined
                    ? provider.authFile === undefined
                        ? null
                        : await CodexSessionCredential.tryLoad({ authFile: provider.authFile })
                    : ((await CodexApiKeyCredential.tryLoad({ apiKey: provider.apiKey })) ??
                      (provider.authFile === undefined
                          ? null
                          : await CodexSessionCredential.tryLoad({
                                authFile: provider.authFile,
                            })))
                : await loadCodexCredential({
                      ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
                      ...(provider.authFile === undefined ? {} : { authFile: provider.authFile }),
                  });
        if (credential === null) {
            throw new Error(`Codex authentication is unavailable for provider "${id}".`);
        }
        return new CodexProvider({
            credential,
            parallelToolCalls: true,
            ...(provider.baseUrl === undefined ? {} : { endpoint: provider.baseUrl }),
            ...(provider.transport === undefined || provider.transport === "auto"
                ? {}
                : {
                      transport:
                          provider.transport === "websocket-cached"
                              ? ("websocket" as const)
                              : provider.transport,
                  }),
            ...(retryLimit === undefined ? {} : { inferenceMaxRetries: retryLimit }),
        });
    }
    if (provider.type === "claude") {
        const credential =
            provider.credentialIsolation === true
                ? ((provider.oauthToken === undefined
                      ? null
                      : await ClaudeOAuthCredential.tryLoad({
                            oauthToken: provider.oauthToken,
                        })) ??
                  (provider.apiKey === undefined
                      ? null
                      : await ClaudeApiKeyCredential.tryLoad({ apiKey: provider.apiKey })) ??
                  (provider.authToken === undefined
                      ? null
                      : await ClaudeAuthTokenCredential.tryLoad({
                            authToken: provider.authToken,
                        })) ??
                  (provider.configDir === undefined
                      ? null
                      : await ClaudeCodeCredential.tryLoad({ configDir: provider.configDir })))
                : ((await ClaudeOAuthCredential.tryLoad(
                      provider.oauthToken === undefined ? {} : { oauthToken: provider.oauthToken },
                  )) ??
                  (await ClaudeApiKeyCredential.tryLoad(
                      provider.apiKey === undefined ? {} : { apiKey: provider.apiKey },
                  )) ??
                  (await ClaudeAuthTokenCredential.tryLoad(
                      provider.authToken === undefined ? {} : { authToken: provider.authToken },
                  )) ??
                  (await ClaudeCodeCredential.tryLoad(
                      provider.configDir === undefined ? {} : { configDir: provider.configDir },
                  )));
        if (credential === null) {
            throw new Error(`Claude authentication is unavailable for provider "${id}".`);
        }
        return new AnthropicProvider({
            credential,
            ...(provider.executable === undefined
                ? {}
                : { pathToClaudeCodeExecutable: provider.executable }),
            ...(retryLimit === undefined ? {} : { inferenceMaxRetries: retryLimit }),
        });
    }
    if (provider.type === "grok") {
        const credential =
            provider.credentialIsolation === true
                ? ((provider.apiKey === undefined
                      ? null
                      : await GrokApiKeyCredential.tryLoad({
                            apiKey: provider.apiKey,
                            env: {},
                        })) ??
                  (provider.authFile === undefined
                      ? null
                      : ((await GrokApiKeyCredential.tryLoad({
                            authFile: provider.authFile,
                            env: {},
                        })) ??
                        (await GrokSessionCredential.tryLoad({
                            authFile: provider.authFile,
                            env: {},
                        })))))
                : ((await GrokApiKeyCredential.tryLoad({
                      ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
                      ...(provider.authFile === undefined ? {} : { authFile: provider.authFile }),
                  })) ??
                  (await GrokSessionCredential.tryLoad(
                      provider.authFile === undefined ? {} : { authFile: provider.authFile },
                  )));
        if (credential === null) {
            throw new Error(`Grok authentication is unavailable for provider "${id}".`);
        }
        return new GrokProvider({
            credential,
            ...(provider.baseUrl === undefined ? {} : { endpoint: provider.baseUrl }),
            ...(retryLimit === undefined ? {} : { inferenceMaxRetries: retryLimit }),
        });
    }
    const credential = await BedrockBearerTokenCredential.tryLoad(
        provider.credentialIsolation === true
            ? provider.bearerToken === undefined && provider.bearerTokenEnvVar === undefined
                ? { env: {} }
                : {
                      ...(provider.bearerToken === undefined
                          ? {}
                          : { bearerToken: provider.bearerToken }),
                      ...(provider.bearerTokenEnvVar === undefined
                          ? {}
                          : { bearerTokenEnvVar: provider.bearerTokenEnvVar }),
                      env: provider.bearerTokenEnvVar === undefined ? {} : process.env,
                  }
            : {
                  ...(provider.bearerToken === undefined
                      ? {}
                      : { bearerToken: provider.bearerToken }),
                  ...(provider.bearerTokenEnvVar === undefined
                      ? {}
                      : { bearerTokenEnvVar: provider.bearerTokenEnvVar }),
              },
    );
    if (credential === null) {
        throw new Error(`Bedrock authentication is unavailable for provider "${id}".`);
    }
    const override =
        selectedModel === undefined ? undefined : provider.modelOverrides?.[selectedModel];
    const region = override?.region ?? provider.region;
    const transport = override?.transport;
    if (selectedModel?.startsWith("anthropic/") === true) {
        return new AnthropicProvider({
            credential,
            ...(override?.endpoint === undefined ? {} : { endpoint: override.endpoint }),
            ...(selectedModel === undefined ? {} : { model: selectedModel }),
            ...(region === undefined ? {} : { region }),
            ...(transport === undefined ? {} : { transport }),
            ...(retryLimit === undefined ? {} : { inferenceMaxRetries: retryLimit }),
        });
    }
    return new CodexProvider({
        credential,
        ...(override?.endpoint === undefined ? {} : { endpoint: override.endpoint }),
        ...(selectedModel === undefined ? {} : { model: selectedModel }),
        ...(region === undefined ? {} : { region }),
        ...(retryLimit === undefined ? {} : { inferenceMaxRetries: retryLimit }),
    });
}

function createVanillaIntegrations(
    configuration?: HappyAgentConfiguration,
): HappyAgentIntegrations {
    const unavailable = async () => {
        throw new Error("This integration is unavailable in the vanilla local host.");
    };
    return {
        happy: {
            notify: async () => ({ accepted: false }),
            setStatus: async () => ({ accepted: false }),
        },
        imageGeneration: { generate: unavailable },
        mcp: {
            callTool: unavailable,
            getPrompt: unavailable,
            listPrompts: async () => ({ prompts: [] }),
            listResourceTemplates: async () => ({ resourceTemplates: [] }),
            listResources: async () => ({ resources: [] }),
            listServers: async () => ({ servers: [] }),
            listTools: async () => ({ tools: [] }),
            readResource: unavailable,
        },
        scheduling: {
            cancel: unavailable,
            reportDelivery: unavailable,
            schedule: unavailable,
            startWait: unavailable,
            wait: unavailable,
        },
        search: {
            fetch: async (_ctx: unknown, _agentId: string, input: { readonly url: string }) => ({
                content: "",
                truncated: false,
                url: input.url,
            }),
            search: async (_ctx: unknown, _agentId: string, query: { readonly query: string }) => ({
                query: query.query,
                results: [],
            }),
        },
        userInput: { wait: unavailable },
        workflows: {
            cancel: unavailable,
            launch: unavailable,
            resume: unavailable,
            wait: unavailable,
        },
    } as unknown as HappyAgentIntegrations;
}

function validateCredentialIsolation(configuration?: HappyAgentConfiguration): void {
    if (configuration === undefined) return;
    for (const [id, provider] of Object.entries(configuration.values.providers)) {
        if (provider.enabled === false || provider.credentialIsolation !== true) continue;
        const hasExplicitCredential =
            provider.type === "codex"
                ? provider.apiKey !== undefined || provider.authFile !== undefined
                : provider.type === "claude"
                  ? provider.apiKey !== undefined ||
                    provider.authToken !== undefined ||
                    provider.oauthToken !== undefined ||
                    provider.configDir !== undefined
                  : provider.type === "grok"
                    ? provider.apiKey !== undefined || provider.authFile !== undefined
                    : provider.bearerToken !== undefined ||
                      provider.bearerTokenEnvVar !== undefined;
        if (!hasExplicitCredential) {
            throw new Error(
                `Provider "${id}" has credential isolation enabled but no explicit credential material or isolated credential path.`,
            );
        }
    }
}

function model(
    providerId: string,
    id: string,
    name: string,
    effortLevels: AgentModel["effortLevels"] = ["off", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: AgentModel["defaultEffort"] = "medium",
    serviceTiers?: AgentModel["serviceTiers"],
): AgentModel {
    return {
        defaultEffort,
        effortLevels,
        id,
        name,
        providerId,
        ...(serviceTiers === undefined ? {} : { serviceTiers }),
    };
}
