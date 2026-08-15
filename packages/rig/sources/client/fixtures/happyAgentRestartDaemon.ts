import {
    AgentProviders,
    startHappyAgentDaemon,
    type AgentModel,
    type HappyAgentDaemon,
    type HappyAgentIntegrations,
} from "@slopus/happy-agent";
import { createRootContext, type RootContext } from "@steve.kite/stdlib";

const [agentHome, publicHome, attemptValue] = process.argv.slice(2);
if (agentHome === undefined || publicHome === undefined || attemptValue === undefined) {
    throw new Error("The restart fixture requires agent home, public home, and attempt.");
}
const attempt = Number(attemptValue);
const providers = new AgentProviders();
providers.add("scripted", restartProvider(attempt), "gym");
const models: readonly AgentModel[] = [
    {
        defaultEffort: "medium",
        effortLevels: ["low", "medium", "high"],
        id: "scripted-model",
        name: "Scripted Model",
        providerId: "scripted",
    },
];
const ctx = createRootContext() as unknown as RootContext;
let daemon: HappyAgentDaemon | undefined;

try {
    daemon = await startHappyAgentDaemon(ctx, {
        agentHome,
        integrations: unavailableIntegrations(),
        models,
        provider: "scripted",
        providers,
        publicHome,
        version: "restart-fixture",
    });
    process.send?.({ type: "ready" });
} catch (error) {
    process.send?.({
        error: errorDetails(error),
        type: "failed",
    });
    process.exitCode = 1;
}

process.on("message", (message: unknown) => {
    if (
        message !== null &&
        typeof message === "object" &&
        Reflect.get(message, "type") === "shutdown"
    ) {
        void closeAndExit();
    }
});
process.on("SIGTERM", () => {
    void closeAndExit();
});

async function closeAndExit(): Promise<void> {
    await daemon?.close(ctx.named("fixture-shutdown")).catch(() => undefined);
    process.exit(0);
}

function errorDetails(error: unknown): string {
    const messages: string[] = [];
    let current = error;
    while (current instanceof Error) {
        messages.push(current.stack ?? current.message);
        current = current.cause;
    }
    return messages.join("\nCaused by: ");
}

function restartProvider(attemptNumber: number): Parameters<AgentProviders["add"]>[1] {
    return {
        inputTypes: ["text"],
        name: "restartable",
        outputTypes: ["text"],
        session: async (id: string) => ({
            id,
            compact: async () => {
                throw new Error("Compaction is unavailable in the restart fixture.");
            },
            destroy: () => undefined,
            run: () =>
                (async function* () {
                    yield { type: "block_start" as const };
                    yield { type: "text_start" as const };
                    if (attemptNumber === 1) {
                        yield { delta: "unfinished", type: "text_delta" as const };
                        await new Promise<void>(() => undefined);
                        return;
                    }
                    yield { delta: "Recovered after restart.", type: "text_delta" as const };
                    yield { type: "text_end" as const };
                    yield { type: "block_stop" as const };
                    yield {
                        state: "normal" as const,
                        tokens: { input: 2, output: 4 },
                        type: "done" as const,
                    };
                })(),
        }),
    } as never;
}

function unavailableIntegrations(): HappyAgentIntegrations {
    const unavailable = async () => {
        throw new Error("This integration is unavailable in the restart fixture.");
    };
    return {
        collaboration: {
            config: async () => undefined,
            create: async (
                _ctx: Parameters<HappyAgentIntegrations["collaboration"]["create"]>[0],
                _config: Parameters<HappyAgentIntegrations["collaboration"]["create"]>[1],
                options: Parameters<HappyAgentIntegrations["collaboration"]["create"]>[2],
            ) => ({ id: options.id }),
            send: async () => undefined,
            wait: unavailable,
        },
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
            fetch: async (
                _ctx: Parameters<HappyAgentIntegrations["search"]["fetch"]>[0],
                _agentId: Parameters<HappyAgentIntegrations["search"]["fetch"]>[1],
                input: Parameters<HappyAgentIntegrations["search"]["fetch"]>[2],
            ) => ({
                content: "",
                truncated: false,
                url: input.url,
            }),
            search: async (
                _ctx: Parameters<HappyAgentIntegrations["search"]["search"]>[0],
                _agentId: Parameters<HappyAgentIntegrations["search"]["search"]>[1],
                input: Parameters<HappyAgentIntegrations["search"]["search"]>[2],
            ) => ({ query: input.query, results: [] }),
        },
        slots: { publisher: async () => undefined, scopeResolver: async () => false },
        userInput: { wait: unavailable },
        workflows: {
            cancel: unavailable,
            launch: unavailable,
            resume: unavailable,
            wait: unavailable,
        },
        worklets: {
            invokeOperation: unavailable,
            readLogs: async () => ({ lines: [] }),
            status: async () => ({ name: "unavailable", status: "stopped" }),
        },
    } as unknown as HappyAgentIntegrations;
}
