import {
    CodexApiKeyCredential,
    CodexImageGenerationError,
    CodexProvider,
    CodexSessionCredential,
    codex_hosted_tools,
} from "@slopus/rig-providers";
import {
    builtinModelProfiles,
    ExecutorImageGenerationUnavailableError,
    type ExecutorProvider,
    type HostedCapability,
} from "@slopus/rig-execution";

import type { ConfigCodexProvider } from "../config/types.js";

export function codexExecution(options: {
    apiKey?: string;
    config: ConfigCodexProvider;
    env: NodeJS.ProcessEnv;
    /**
     * The searches to declare on the request being built, asked once per request.
     *
     * Only the answer given while the request is being built can be enforced: OpenAI runs the
     * search inside its own response, so nothing about it can be taken back afterwards.
     */
    hostedCapabilitiesForRequest?: () => readonly HostedCapability[];
    id: string;
    resolveInferenceMaxRetries?: () => number;
    sessionId?: string;
}): ExecutorProvider {
    const baseUrl = options.config.baseUrl ?? options.env.RIG_CODEX_BASE_URL;
    const transport = options.config.transport ?? options.env.RIG_CODEX_TRANSPORT;
    const loadCredential = async () =>
        (options.apiKey === undefined
            ? null
            : await CodexApiKeyCredential.tryLoad({ apiKey: options.apiKey })) ??
        (await CodexSessionCredential.tryLoad({
            env: options.env,
            ...(options.config.authFile === undefined ? {} : { authFile: options.config.authFile }),
        }));
    const hostedTools = (capabilities: () => readonly HostedCapability[]) => () => {
        const held = capabilities();
        return held.length === 0
            ? []
            : codex_hosted_tools.filter((tool) => (held as readonly string[]).includes(tool.name));
    };
    const createNative = (
        credential: NonNullable<Awaited<ReturnType<typeof loadCredential>>>,
        capabilities: () => readonly HostedCapability[] = () =>
            options.hostedCapabilitiesForRequest?.() ?? [],
    ) =>
        new CodexProvider({
            credential,
            // Web search runs on OpenAI's backend the way the Codex CLI does, rather than through
            // a tool Rig would have to execute.
            hostedTools: hostedTools(capabilities),
            parallelToolCalls: true,
            ...(options.resolveInferenceMaxRetries === undefined
                ? {}
                : { resolveInferenceMaxRetries: options.resolveInferenceMaxRetries }),
            ...(baseUrl === undefined ? {} : { endpoint: baseUrl }),
            ...(transport === "auto" || transport === "sse" || transport === "websocket"
                ? { transport }
                : transport === "websocket-cached"
                  ? { transport: "websocket" as const }
                  : {}),
        });
    const native = async () => {
        const credential = await loadCredential();
        if (credential === null) {
            throw new Error(
                "Codex authentication is unavailable. Sign in with Codex or configure an API key.",
            );
        }
        return createNative(credential);
    };
    return {
        id: options.id,
        imageGeneration: {
            generate: async (request) => {
                let credential: Awaited<ReturnType<typeof loadCredential>>;
                try {
                    credential = await loadCredential();
                } catch (error) {
                    throw new ExecutorImageGenerationUnavailableError(
                        "A configured Codex image provider's authentication could not be loaded.",
                        { cause: error },
                    );
                }
                if (credential === null) {
                    throw new ExecutorImageGenerationUnavailableError(
                        "A configured Codex image provider has no available authentication.",
                    );
                }
                try {
                    return await createNative(credential).generateImage(request);
                } catch (error) {
                    if (error instanceof CodexImageGenerationError && error.fallbackEligible) {
                        throw new ExecutorImageGenerationUnavailableError(error.message, {
                            cause: error,
                        });
                    }
                    throw error;
                }
            },
        },
        profiles: builtinModelProfiles(options.id, "codex"),
        serviceTiers: ["fast"],
        sessionId: options.sessionId ?? options.id,
        native,
    };
}
