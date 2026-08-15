import { createNodeAgentContext } from "../agent/index.js";
import { DEFAULT_RIG_CONFIG } from "../config/defaultConfig.js";
import type { ConfigProviders } from "../config/types.js";
import { NativeProcessManager } from "../processes/index.js";
import type { ModelCatalog } from "../protocol/index.js";
import { createExecutor } from "../executor/createExecutor.js";
import { createGymProviderFromEnvironment } from "../executor/createGymProviderFromEnvironment.js";
import {
    modelOpenaiGpt56Luna,
    modelOpenaiGpt56Sol,
    modelOpenaiGpt56Terra,
} from "@slopus/rig-execution";
import { uniqueModelsById } from "./uniqueModelsById.js";
import type { Context } from "@steve.kite/stdlib";

export interface CreateModelCatalogOptions {
    cwd?: string;
    disabledProviderReasons?: ReadonlyMap<
        string,
        "not_authenticated" | "not_enabled" | "no_models"
    >;
    env?: NodeJS.ProcessEnv;
    providers?: ConfigProviders;
}

export function createModelCatalog(
    ctx: Context,
    options: CreateModelCatalogOptions = {},
): ModelCatalog {
    const cwd = options.cwd ?? process.cwd();
    const env = options.env ?? process.env;
    const providerSettings = options.providers ?? DEFAULT_RIG_CONFIG.providers;
    const context = createNodeAgentContext(ctx, {
        cwd,
        processManager: new NativeProcessManager(),
    });
    const providerCatalogs: ModelCatalog["providers"][number][] = [];
    const gymProvider = createGymProviderFromEnvironment(env);
    const gymEnabled = gymProvider !== undefined;
    if (gymProvider !== undefined) {
        providerCatalogs.unshift({
            models: gymProvider.models,
            providerId: gymProvider.id,
            providerType: "gym",
            ...(gymProvider.serviceTiers === undefined
                ? {}
                : { serviceTiers: gymProvider.serviceTiers }),
        });
    }
    const executorProviders = Object.fromEntries(
        Object.entries(providerSettings).map(([id, config]) => [
            id,
            options.disabledProviderReasons?.has(id) ? { ...config, enabled: false } : config,
        ]),
    );
    const executorResult = createExecutor({
        agentContext: context,
        allowEmptyModels: true,
        env,
        providers: executorProviders,
    });
    const definitionsById = new Map(
        (executorResult.executor?.providers ?? []).map((provider) => [provider.id, provider]),
    );
    for (const [configuredId, config] of Object.entries(providerSettings)) {
        const id = configuredId;
        if (providerCatalogs.some((provider) => provider.providerId === id)) {
            throw new Error(`Inference provider '${id}' is configured more than once.`);
        }
        const configuredDisabledReason = options.disabledProviderReasons?.get(id);
        const disabledReason = !config.enabled
            ? "not_enabled"
            : configuredDisabledReason === "not_enabled"
              ? "not_enabled"
              : configuredDisabledReason;
        if (disabledReason !== undefined) {
            providerCatalogs.push({
                disabledReason,
                models: [],
                providerId: id,
                providerType: config.type,
            });
            continue;
        }

        const definition = definitionsById.get(id);
        if (definition === undefined) {
            providerCatalogs.push({
                disabledReason: "not_authenticated",
                models: [],
                providerId: id,
                providerType: config.type,
            });
            continue;
        }
        const models = definition.profiles
            .filter((profile) => profile.hidden !== true)
            .map((profile) => profile.model);
        if (models.length === 0) {
            providerCatalogs.push({
                disabledReason: "no_models",
                models: [],
                providerId: id,
                providerType: config.type,
            });
            continue;
        }
        providerCatalogs.push({
            models,
            providerId: definition.id,
            providerType: config.type,
            ...(definition.serviceTiers === undefined
                ? {}
                : { serviceTiers: definition.serviceTiers }),
        });
    }

    const availableProviders = providerCatalogs.filter(
        (provider) => provider.disabledReason === undefined && provider.models.length > 0,
    );
    const defaultProvider = availableProviders[0];
    if (defaultProvider === undefined) {
        return {
            defaultModelId: "",
            defaultProviderId: "",
            models: [],
            providers: providerCatalogs,
        };
    }
    const defaultModel = gymEnabled
        ? (defaultProvider.models.find((model) => model.id === "openai/gym") ??
          defaultProvider.models[0])
        : (defaultProvider.models.find((model) => model.id === modelOpenaiGpt56Sol.id) ??
          defaultProvider.models.find((model) => model.id === modelOpenaiGpt56Terra.id) ??
          defaultProvider.models.find((model) => model.id === modelOpenaiGpt56Luna.id) ??
          defaultProvider.models[0]);
    if (defaultModel === undefined) {
        throw new Error("No inference models are currently available.");
    }

    return {
        defaultModelId: defaultModel.id,
        defaultProviderId: defaultProvider.providerId,
        models: uniqueModelsById(availableProviders.flatMap((provider) => provider.models)),
        providers: providerCatalogs,
    };
}
