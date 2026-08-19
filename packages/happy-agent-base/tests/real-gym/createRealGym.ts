import type { SessionReasoningEffort } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import {
    AgentKV,
    AgentProviders,
    AgentSystemLocal,
    currentAgentEnvironment,
    type Agent,
} from "../../sources/index.js";
import { InMemoryAgentStorage, inMemoryStorageLock } from "../gym/fixtures.js";
import { InMemoryPersistence } from "../gym/InMemoryPersistence.js";
import { loadRealProvider, type RealGymVendor } from "./loadRealProvider.js";
import { REAL_GYM_MODULES, realGymModels } from "./realGymModules.js";
import { textOf, type RealGymTrace, type RealGymTraces } from "./RealGymTrace.js";
import { TracingProvider } from "./TracingProvider.js";

export interface RealGymOptions {
    /** A short human-readable name; it titles the scenario in the report. */
    readonly scenario: string;
    readonly vendor: RealGymVendor;
    /** A Rig model ID, such as `openai/gpt-5.6-sol`; the vendor maps it to its own wire ID. */
    readonly model: string;
    readonly effort?: SessionReasoningEffort;
    /** Where the scenario's trace is collected. */
    readonly traces: RealGymTraces;
}

/**
 * One live agent talking to one real vendor, assembled the way the product assembles agents:
 * an `AgentSystemLocal` collection over real storage, the real module classes, and a provider built from
 * the credentials the installed assistant already manages. The agent is created explicitly with
 * its configuration and resolved from the collection, so the whole path — configuration,
 * module loading, prompt assembly, tools, the loop, and durable persistence — is the product's
 * own. Only the answers come from outside.
 *
 * Returns null when the machine is not signed in to that assistant, so a caller can report the
 * missing sign-in instead of failing as though the product were broken.
 */
export async function createRealGym(
    ctx: Context,
    options: RealGymOptions,
): Promise<RealGym | null> {
    const real = await loadRealProvider(options.vendor);
    if (real === null) return null;

    const environment = currentAgentEnvironment();
    const models = realGymModels(options.vendor);
    const trace = options.traces.open({
        scenario: options.scenario,
        vendor: options.vendor,
        model: options.model,
        credential: real.credential,
        environment,
        modules: REAL_GYM_MODULES.map((module) => module.name),
        models: models.map((model) => model.id),
    });

    const providers = new AgentProviders();
    providers.add(options.vendor, new TracingProvider(real.provider, trace), real.type);
    // One in-memory store per agent, plus the collection's own; the gym asserts against the
    // records they end up holding.
    const persistence = new InMemoryPersistence();
    const agents = await AgentSystemLocal.create(
        ctx,
        new InMemoryAgentStorage({
            acquireLock: inMemoryStorageLock(),
            kv: new AgentKV(new InMemoryPersistence(), "agents."),
            persistence: () => persistence,
        }),
        {
            modules: REAL_GYM_MODULES.map((module) => new module.Module()),
            providers,
            provider: options.vendor,
            models,
        },
    );
    const agent = await agents.create(ctx, {
        environment,
        modules: { gym: { scenario: options.scenario } },
    });
    // The collection allocates the identity, so the trace learns it from the agent it built.
    trace.agentId = agent.id;
    // The collection selects the provider; the model and effort travel with the first message.
    return new RealGym(agents, agent, persistence, trace, options.model, options.effort);
}

export class RealGym {
    readonly agents: AgentSystemLocal;
    readonly agent: Agent;
    readonly trace: RealGymTrace;

    readonly #persistence: InMemoryPersistence;
    readonly #model: string;
    readonly #effort: SessionReasoningEffort | undefined;

    constructor(
        agents: AgentSystemLocal,
        agent: Agent,
        persistence: InMemoryPersistence,
        trace: RealGymTrace,
        model: string,
        effort: SessionReasoningEffort | undefined,
    ) {
        this.agents = agents;
        this.agent = agent;
        this.#persistence = persistence;
        this.trace = trace;
        this.#model = model;
        this.#effort = effort;
    }

    /** Say one thing through the collection and wait for the agent to settle. */
    async ask(ctx: Context, text: string): Promise<string> {
        this.trace.prompt = text;
        await this.agents.send(
            ctx,
            this.trace.agentId,
            { role: "user", content: [{ type: "text", text }] },
            {
                model: this.#model,
                ...(this.#effort === undefined ? {} : { effort: this.#effort }),
            },
        );
        await this.agent.waitForIdle();
        const response = this.text;
        this.trace.response = response;
        return response;
    }

    /** Everything the model said during the scenario, in order. */
    get text(): string {
        return this.trace.inferences
            .map((inference) => textOf(inference))
            .filter((text) => text.length > 0)
            .join("\n");
    }

    /** The conversation the durable records hold right now, as a restart would rebuild it. */
    get transcript(): RealGymTrace["transcript"] {
        return transcriptOf(this.#persistence);
    }

    /** Close the scenario, recording the durable transcript and how it went. */
    async close(outcome: "passed" | "failed", failure?: string): Promise<void> {
        this.trace.transcript = this.transcript;
        this.trace.outcome = outcome;
        this.trace.failure = failure;
        this.trace.finishedAtMs = Date.now();
        await this.agent.close();
    }
}

/** The conversation the durable records rebuild, the same way a restart would read it. */
function transcriptOf(persistence: InMemoryPersistence): RealGymTrace["transcript"] {
    const messages: RealGymTrace["transcript"] = [];
    const rebuilt = [...messages];
    for (const record of persistence.records) {
        if (record.type === "compaction") {
            rebuilt.length = 0;
            rebuilt.push(...record.messages);
            continue;
        }
        if (record.type === "block") {
            const last = rebuilt[rebuilt.length - 1];
            if (last?.role === "assistant") {
                rebuilt[rebuilt.length - 1] = {
                    role: "assistant",
                    content: [...last.content, record.block],
                };
            } else {
                rebuilt.push({ role: "assistant", content: [record.block] });
            }
            continue;
        }
        rebuilt.push(record.message);
    }
    return rebuilt;
}
