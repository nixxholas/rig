import type {
    AgentBaseModelChange,
    AgentFeature,
    AgentFeatureScope,
    AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { SessionSystemMessage } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type { HistoryFeature } from "../history/HistoryFeature.js";
import { createHistoryExcerpt } from "./impl/createHistoryExcerpt.js";
import { createModelSwitchNotice } from "./impl/createModelSwitchNotice.js";

/** How much of the erased conversation the notice may carry. */
const MAX_EXCERPT_CHARACTERS = 32_000;

/** What a model-switch feature is built with. */
export interface ModelSwitchFeatureOptions {
    /**
     * The tool that reads the agent's durable history, when the agent is given one. The notice
     * names it so the new model can go and read what it can no longer see.
     */
    readonly historyTool?: string;
    /**
     * The agent's history, when it keeps one. The notice then carries an overview and both ends
     * of the erased conversation, so the new model starts by reading what happened rather than
     * only being told that something did.
     */
    readonly history?: HistoryFeature;
}

/**
 * The notice a model gets when it inherits a conversation it cannot see.
 *
 * Switching between incompatible models erases the conversation: their transcripts cannot be
 * replayed to one another, so the new model starts with an empty context while the work the old
 * one did still stands. Left to itself it would answer the next message as though nothing had
 * happened. This feature puts one system message at the head of that fresh context saying what
 * changed and that a conversation it cannot see came before, so the model orients itself instead
 * of starting over.
 *
 * A compatible switch keeps the history and needs no notice, and none is produced.
 */
export class ModelSwitchFeature implements AgentFeature {
    readonly name = "model-switch";

    /** The history tool the notice names, when the agent has one. */
    readonly #historyTool: string | undefined;
    /** The history the notice quotes, when the agent keeps one. */
    readonly #history: HistoryFeature | undefined;
    /** The collection this feature belongs to, which is where model labels come from. */
    #agents: AgentSystemRef | undefined;

    constructor(options: ModelSwitchFeatureOptions = {}) {
        this.#historyTool = options.historyTool;
        this.#history = options.history;
    }

    /** Keep the collection, so a model can be named the way a person would name it. */
    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): Promise<void> => {
        this.#agents = agents;
        return Promise.resolve();
    };

    readonly modelChanged = async (
        ctx: Context,
        scope: AgentFeatureScope,
        change: AgentBaseModelChange,
    ): Promise<SessionSystemMessage | undefined> => {
        // A compatible change carries the history across, so there is nothing to explain.
        if (!change.wasReset) return undefined;
        const text = createModelSwitchNotice({
            previousModel: this.#label(change.previousModel, change.previousProvider),
            previousProvider: change.previousProvider,
            model: this.#label(change.model, change.provider),
            provider: change.provider,
            ...(this.#historyTool === undefined ? {} : { historyTool: this.#historyTool }),
            ...(await this.#excerpt(ctx, scope.agent.id)),
        });
        return { role: "system", content: [{ type: "text", text }] };
    };

    /**
     * The two ends of the conversation being erased, when there is a history to read them from.
     *
     * A failure here is deliberately not fatal. This hook runs inside the switch: a rejection
     * rejects the switch itself and leaves the agent on the old model, which is far worse than a
     * notice that quotes nothing. So an unreadable history costs the excerpt and nothing else.
     */
    async #excerpt(ctx: Context, agentId: string) {
        if (this.#history === undefined) return {};
        try {
            const records = await this.#history.messages(ctx, agentId);
            if (records.length === 0) return {};
            return { excerpt: createHistoryExcerpt(records, MAX_EXCERPT_CHARACTERS) };
        } catch {
            return {};
        }
    }

    /** What to call a model: its picker label when the collection offers it, else its ID. */
    #label(model: string | undefined, providerId: string): string {
        if (model === undefined) return "an unnamed model";
        const offered = this.#agents?.models.find(
            (candidate) => candidate.id === model && candidate.providerId === providerId,
        );
        return offered?.name ?? model;
    }
}
