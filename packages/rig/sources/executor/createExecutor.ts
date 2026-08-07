import { release } from "node:os";

import type { ProviderUsage } from "@slopus/rig-providers";
import { Executor, type ExecutorProvider, type Identity } from "@slopus/rig-execution";

import type { AgentContext } from "../agent/context/AgentContext.js";
import type { ConfigProvider, ConfigProviders } from "../config/types.js";
import type { OneOffInferenceRoute, SearchInferenceRoutes } from "../tools/search/index.js";
import { configuredBedrockExecution } from "./configuredBedrockExecution.js";
import { claudeExecution } from "./claudeExecution.js";
import { codexExecution } from "./codexExecution.js";
import { grokExecution } from "./grokExecution.js";
import { filterConfiguredProviderModels } from "./filterConfiguredProviderModels.js";

export interface CreateExecutorOptions {
    agentContext: AgentContext;
    allowEmptyModels?: boolean;
    apiKey?: string;
    env: NodeJS.ProcessEnv;
    identity?: Identity;
    /** Receives account usage a provider reports while it is already answering. */
    onAccountUsage?: (usage: ProviderUsage) => void;
    providers: ConfigProviders;
    resolveInferenceMaxRetries?: () => number;
    sessionId?: string;
}

export interface CreateExecutorResult {
    executor?: Executor;
    missingCredentials: ReadonlyMap<string, string>;
    searchRoutes: SearchInferenceRoutes;
}

export function createExecutor(options: CreateExecutorOptions): CreateExecutorResult {
    const definitions: ExecutorProvider[] = [];
    const missingCredentials = new Map<string, string>();
    const searchRoutes: SearchInferenceRoutes = {
        claudeRoutes: [],
        codexRoutes: [],
        grokRoutes: [],
    };
    for (const [id, config] of Object.entries(options.providers)) {
        if (!config.enabled) continue;
        const configured = configuredExecutor(options, id, config);
        if (configured === undefined) {
            missingCredentials.set(
                id,
                config.type === "bedrock"
                    ? (config.bearerTokenEnvVar ?? "AWS_BEARER_TOKEN_BEDROCK")
                    : "local coding-assistant authentication",
            );
            continue;
        }
        const filtered = filterConfiguredProviderModels(
            configured,
            config,
            options.allowEmptyModels === undefined ? {} : { allowEmpty: options.allowEmptyModels },
        );
        definitions.push(filtered);
        const route = firstVisibleRoute(filtered);
        if (route !== undefined) {
            if (config.type === "claude") {
                searchRoutes.claudeRoutes = [...searchRoutes.claudeRoutes, route];
            }
            if (config.type === "codex") {
                searchRoutes.codexRoutes = [...searchRoutes.codexRoutes, route];
            }
            if (config.type === "grok") {
                searchRoutes.grokRoutes = [...searchRoutes.grokRoutes, route];
            }
        }
    }
    return {
        ...(definitions.length === 0
            ? {}
            : {
                  executor: new Executor(definitions, {
                      environment: {
                          osVersion: release(),
                          platform: process.platform,
                          primaryWorkingDirectory: options.agentContext.fs.cwd,
                          shell: options.env.SHELL ?? "",
                      },
                      ...(options.identity === undefined ? {} : { identity: options.identity }),
                  }),
              }),
        missingCredentials,
        searchRoutes,
    };
}

function firstVisibleRoute(provider: ExecutorProvider): OneOffInferenceRoute | undefined {
    const profile = provider.profiles.find((candidate) => candidate.hidden !== true);
    return profile === undefined ? undefined : { profile, provider };
}

function configuredExecutor(
    options: CreateExecutorOptions,
    id: string,
    config: ConfigProvider,
): ExecutorProvider | undefined {
    return config.type === "codex"
        ? codexExecution({
              ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
              config,
              env: options.env,
              id,
              ...(options.resolveInferenceMaxRetries === undefined
                  ? {}
                  : {
                        resolveInferenceMaxRetries: options.resolveInferenceMaxRetries,
                    }),
              ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
          })
        : config.type === "claude"
          ? claudeExecution({
                config,
                env: options.env,
                id,
                ...(options.onAccountUsage === undefined
                    ? {}
                    : { onAccountUsage: options.onAccountUsage }),
                ...(options.resolveInferenceMaxRetries === undefined
                    ? {}
                    : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
                ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
            })
          : config.type === "grok"
            ? grokExecution({
                  ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
                  config,
                  env: options.env,
                  id,
                  ...(options.resolveInferenceMaxRetries === undefined
                      ? {}
                      : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
                  ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
              })
            : configuredBedrockExecution({
                  ...(options.sessionId === undefined ? {} : { agentId: options.sessionId }),
                  config,
                  env: options.env,
                  id,
                  ...(options.resolveInferenceMaxRetries === undefined
                      ? {}
                      : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
              });
}
