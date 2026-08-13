import type { SessionDoneState, SessionEvent } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import type { AgentBaseKV } from "../AgentBaseKV.js";
import type { AgentSystem } from "../AgentSystem.js";
import {
    agentBaseEffort,
    agentBaseModel,
    agentBaseProvider,
    agentBaseServiceTier,
} from "../AgentBaseContext.js";
import { agentConfig } from "../AgentConfig.js";
import { agentSystem } from "../AgentSystemContext.js";
import type { AgentFeature } from "../AgentFeature.js";
import { defineAgentTool } from "../AgentTool.js";

/** The key under which a child keeps the report it still owes its parent. */
const OUTCOME_KEY = "outcome";

/** How a child's finished run is remembered until its parent has accepted the report. */
interface SubagentOutcome {
    readonly state: SessionDoneState;
    readonly response: string;
}

function subagentOutcome(value: unknown): SubagentOutcome | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const { state, response } = value as { state?: unknown; response?: unknown };
    if (typeof state !== "string" || typeof response !== "string") return undefined;
    return { state: state as SessionDoneState, response };
}

/** Lets an agent start independently running child agents in its owning collection. */
export class FeatureSubagents implements AgentFeature {
    readonly name = "subagents";
    readonly agentId: string;

    #system: AgentSystem | undefined;
    #state: AgentBaseKV | undefined;
    /** Durable writes started by events, so a settle reports nothing it has not yet written. */
    #writing: Promise<void> = Promise.resolve();
    #responseText = "";
    #lastResponseText = "";
    #doneState: SessionDoneState | undefined;

    readonly spawnAgentTool = defineAgentTool({
        name: "spawn_agent",
        description: "Start a subagent for a concrete, bounded task. The child runs independently.",
        parameters: Type.Object(
            {
                task_name: Type.String({
                    pattern: "^[a-z0-9_]+$",
                    minLength: 1,
                    maxLength: 80,
                    description:
                        "Unique child name using lowercase letters, numbers, and underscores.",
                }),
                message: Type.String({
                    minLength: 1,
                    maxLength: 20_000,
                    description: "Initial task for the subagent.",
                }),
                provider_id: Type.Optional(
                    Type.String({
                        minLength: 1,
                        description: "Provider registry ID. Omit to inherit the current provider.",
                    }),
                ),
                model: Type.Optional(
                    Type.String({
                        minLength: 1,
                        description: "Model ID. Omit to inherit the current model.",
                    }),
                ),
                effort: Type.Optional(
                    Type.Union([
                        Type.Literal("off"),
                        Type.Literal("minimal"),
                        Type.Literal("low"),
                        Type.Literal("medium"),
                        Type.Literal("high"),
                        Type.Literal("xhigh"),
                        Type.Literal("max"),
                    ]),
                ),
                service_tier: Type.Optional(Type.Literal("priority")),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({
            agent_id: Type.String(),
        }),
        durable: false,
        execute: async (ctx, { task_name, message, provider_id, model, effort, service_tier }) => {
            const agentId = `${this.agentId}/${task_name}`;
            const provider = provider_id ?? agentBaseProvider(ctx);
            const selectedModel = model ?? agentBaseModel(ctx);
            const selectedEffort = effort ?? agentBaseEffort(ctx);
            const selectedTier = service_tier ?? agentBaseServiceTier(ctx);
            // The child is created explicitly, inheriting the environment its parent works in;
            // a task name already in use fails here and the model picks another.
            const child = await this.agentSystem.create(ctx, agentId, agentConfig(ctx) ?? {});
            try {
                await child.send(
                    ctx,
                    {
                        role: "user",
                        content: [{ type: "text", text: message }],
                    },
                    {
                        // The spawn is one step and reports its own failure, so this is one of
                        // the waits that is worth making: the child is another agent, not the
                        // one whose tool is running, so waiting for its acceptance cannot wait
                        // on this turn.
                        await: true,
                        ...(provider === undefined ? {} : { provider }),
                        ...(selectedModel === undefined ? {} : { model: selectedModel }),
                        ...(selectedEffort === undefined ? {} : { effort: selectedEffort }),
                        ...(selectedTier === undefined ? {} : { serviceTier: selectedTier }),
                    },
                );
            } catch (error) {
                // Spawning is one step: a child that never received its task keeps no name, so
                // the model can retry the same task_name instead of being told it is taken.
                await this.agentSystem.delete(ctx, agentId).catch(() => undefined);
                throw error;
            }
            return { agent_id: agentId };
        },
        toLLM: ({ agent_id }) => [
            {
                type: "text",
                text: `Started subagent ${agent_id}.`,
            },
        ],
    });

    readonly tools = () => [this.spawnAgentTool] as const;
    readonly instructions = (ctx: Context) => {
        const provider = agentBaseProvider(ctx);
        const model = agentBaseModel(ctx);
        const effort = agentBaseEffort(ctx);
        const serviceTier = agentBaseServiceTier(ctx);
        return [
            `Your stable agent path is ${JSON.stringify(this.agentId)}.`,
            `Your current provider is ${JSON.stringify(provider ?? "not selected")}, model is ${JSON.stringify(model ?? "not selected")}, effort is ${JSON.stringify(effort ?? "not selected")}, and service tier is ${JSON.stringify(serviceTier ?? "not selected")}.`,
            "Subagents started with spawn_agent are created beneath this path as <your path>/<task_name>.",
            "A child inherits your current provider, model, effort, and service tier unless spawn_agent receives explicit overrides.",
            "Choose a unique task_name for each new child.",
        ].join("\n");
    };

    constructor(agentId: string) {
        this.agentId = agentId;
    }

    readonly onEvent = (ctx: Context, event: SessionEvent): void => {
        if (event.type === "text_start") {
            this.#responseText = "";
        } else if (event.type === "text_delta") {
            this.#responseText += event.delta;
        } else if (event.type === "text_end") {
            this.#lastResponseText = this.#responseText;
        } else if (event.type === "done") {
            this.#doneState = event.state;
            // A terminal error is the outcome, whatever an earlier inference of the same loop
            // managed to say: reporting text a failure superseded would tell the parent the
            // child answered when it did not.
            if (event.state === "error") this.#lastResponseText = event.message;
            // The outcome becomes durable the moment it is known rather than when it is
            // delivered. A child process that disappears in between still owes its parent a
            // report, and an outcome held only in this instance's memory goes with it.
            this.#remember(ctx, {
                state: this.#doneState,
                response: this.#lastResponseText,
            });
        }
    };

    /** Record the outcome durably, behind whatever an earlier event already started. */
    #remember(ctx: Context, outcome: SubagentOutcome): void {
        const state = this.#state;
        if (state === undefined) return;
        this.#writing = this.#writing
            .then(() => state.write(ctx, OUTCOME_KEY, outcome))
            .catch(() => undefined);
    }

    readonly afterAgentSettled = async (ctx: Context): Promise<void> => {
        const separator = this.agentId.lastIndexOf("/");
        if (separator < 0) return;
        // What is owed is what the store says, not what this instance remembers: the run that
        // produced the outcome may have belonged to a process that is already gone.
        await this.#writing;
        const outcome = subagentOutcome(await this.#state?.read(ctx, OUTCOME_KEY));
        if (outcome === undefined) return;

        const parentId = this.agentId.slice(0, separator);
        // The completion is forgotten only once the parent has durably accepted it. A failed
        // delivery leaves the outcome intact so the next settle reports it instead of losing it.
        await this.agentSystem.steer(
            ctx,
            parentId,
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: subagentNotification(this.agentId, outcome.state, outcome.response),
                    },
                ],
            },
            // The parent is a different agent, so waiting for it to accept is safe from here,
            // and it is the wait that makes the forgetting below correct.
            { await: true },
        );
        await this.#state?.delete(ctx, OUTCOME_KEY);
        this.#responseText = "";
        this.#lastResponseText = "";
        this.#doneState = undefined;
    };

    async load(ctx: Context): Promise<void> {
        const owner = agentSystem(ctx);
        if (owner === undefined) {
            throw new Error("FeatureSubagents requires an agent system context.");
        }
        this.#system = owner;
        this.#state = owner.featureState(this.name).scoped(this.agentId);
    }

    /** The owning agent collection, available after `load` completes. */
    get agentSystem(): AgentSystem {
        if (this.#system === undefined) {
            throw new Error("FeatureSubagents has not been loaded.");
        }
        return this.#system;
    }
}

function subagentNotification(agentId: string, state: SessionDoneState, response: string): string {
    return [
        "<subagent_notification>",
        `<agent_id>${escapeXml(agentId)}</agent_id>`,
        `<state>${state}</state>`,
        "<final_response>",
        escapeXml(response.length === 0 ? "No final text response." : response),
        "</final_response>",
        "</subagent_notification>",
    ].join("\n");
}

function escapeXml(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
