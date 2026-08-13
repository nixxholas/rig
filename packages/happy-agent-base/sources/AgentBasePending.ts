import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type { AgentBasePersistence } from "./AgentBasePersistence.js";

/**
 * The one key an agent's outstanding work lives under, in the agent's own store. It is a single
 * key rather than a prefix of many, because what it records is one fact — that this agent has
 * something left to do — and two keys could disagree about it.
 */
export const AGENT_BASE_PENDING_KEY = "owed";

/**
 * Where a run stopped, and so what has to happen to carry it on. The stage is what a restart
 * reads instead of guessing the answer from the shape of the conversation: a transcript ending
 * in a user message may be a question nobody answered or a response that had nothing to say,
 * and only the run that stopped knows which.
 */
export const AgentBasePendingStage = Type.Union([
    /** An inference request is owed: a message was consumed, or tool results completed. */
    Type.Literal("inference"),
    /** A dispatched tool batch has not delivered all of its results. */
    Type.Literal("tools"),
    /** The conversation is being replaced by the provider's summary of it. */
    Type.Literal("compaction"),
]);
export type AgentBasePendingStage = Static<typeof AgentBasePendingStage>;

/**
 * The agent's outstanding work, as the run itself recorded it. Its presence is the whole of the
 * active flag: a stored record means the agent has work left, and the absence of one means it
 * settled. The run erases it on the way out, so an agent that stopped without erasing it — a
 * process that died mid-turn — is discovered as owing exactly what it was doing.
 */
export const AgentBasePendingState = Type.Object({
    stage: AgentBasePendingStage,
});
export type AgentBasePendingState = Static<typeof AgentBasePendingState>;

/**
 * Read one store's pending state, or undefined when it holds none. Anything stored under the key
 * that is not a pending state is treated as no pending state at all: a store this agent cannot
 * make sense of must not be able to strand an identity in a stage that will never be carried out.
 */
export async function agentBasePendingStateOf(
    ctx: Context,
    persistence: AgentBasePersistence,
): Promise<AgentBasePendingState | undefined> {
    const entries = await persistence.readValues(ctx, AGENT_BASE_PENDING_KEY);
    const stored = entries.find((entry) => entry.key === AGENT_BASE_PENDING_KEY)?.value;
    if (stored === undefined) return undefined;
    if (!Value.Check(AgentBasePendingState, stored)) return undefined;
    return stored;
}

/**
 * Whether one agent's store has work left, asked from outside the agent. This is the question an
 * owner starting up needs answered — which identities are worth resuming — and the one it needs
 * again before declaring an identity finished.
 *
 * Two things count. A pending record means a run was under way and has not erased it, either
 * because it is still running somewhere or because it died. A conversation whose last record is
 * a consumed message, a tool result, or a failure note is owed a response whoever is meant to
 * give it, and that outlives any one process — which is what makes it discoverable at all by an
 * owner that has never seen the run.
 *
 * The caller is responsible for holding the store still; a half-applied step of some owner reads
 * as a whole one otherwise.
 */
export async function agentBaseStoreOwesWork(
    ctx: Context,
    persistence: AgentBasePersistence,
): Promise<boolean> {
    if ((await agentBasePendingStateOf(ctx, persistence)) !== undefined) return true;
    const records = await persistence.load(ctx);
    const last = records[records.length - 1];
    if (last === undefined) return false;
    if (last.type === "user" || last.type === "tool" || last.type === "system") return true;
    // A replacement is not a question in itself, but it keeps the suffix that joined after its
    // snapshot, and only the rewrite that wrote it knows whether that suffix ends in a request.
    return last.type === "compaction" && last.continuesInference === true;
}
