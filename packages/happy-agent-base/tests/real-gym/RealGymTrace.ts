import type {
    SessionEvent,
    SessionMessage,
    SessionReasoningEffort,
    SessionServiceTier,
    SessionTokens,
} from "@slopus/happy-providers";

import type { AgentEnvironment } from "../../sources/index.js";
import type { RealGymVendor } from "./loadRealProvider.js";

/** A tool as the model was shown it, taken from the descriptors the session was created with. */
export interface RealGymTool {
    readonly name: string;
    readonly description: string | undefined;
    readonly parameters: unknown;
}

/** One provider session, with the prompt and tools the features assembled for it. */
export interface RealGymSession {
    readonly instructions: string;
    readonly tools: readonly RealGymTool[];
}

/** One inference request sent to the live provider, with everything it answered. */
export interface RealGymInference {
    readonly model: string | undefined;
    readonly effort: SessionReasoningEffort | undefined;
    readonly serviceTier: SessionServiceTier | undefined;
    /** The complete conversation the provider received for this request. */
    readonly messages: readonly SessionMessage[];
    readonly events: RealGymEvent[];
    startedAtMs: number;
    finishedAtMs: number | undefined;
    tokens: SessionTokens | undefined;
    doneState: string | undefined;
    failure: string | undefined;
}

/** One streamed event, stamped with how long into the run it arrived. */
export interface RealGymEvent {
    readonly atMs: number;
    readonly event: SessionEvent;
}

/** Everything one scenario did against one live vendor. */
export interface RealGymTrace {
    readonly scenario: string;
    readonly vendor: RealGymVendor;
    readonly model: string;
    readonly credential: string;
    /** Assigned once the collection has allocated the agent's identity. */
    agentId: string;
    readonly environment: AgentEnvironment;
    /** The features the agent was assembled from, in the order they contribute. */
    readonly features: readonly string[];
    /** The model routes the collection offered the agent. */
    readonly models: readonly string[];
    readonly sessions: RealGymSession[];
    readonly inferences: RealGymInference[];
    /** The durable conversation the agent ended up with. */
    transcript: readonly SessionMessage[];
    startedAtMs: number;
    finishedAtMs: number | undefined;
    outcome: "passed" | "failed" | "running";
    failure: string | undefined;
    prompt: string | undefined;
    response: string | undefined;
}

type OpenedTrace = Pick<
    RealGymTrace,
    "scenario" | "vendor" | "model" | "credential" | "environment" | "features" | "models"
>;

/** The traces gathered by a whole run, in the order their scenarios started. */
export class RealGymTraces {
    readonly traces: RealGymTrace[] = [];

    open(trace: OpenedTrace): RealGymTrace {
        const opened: RealGymTrace = {
            ...trace,
            agentId: "",
            sessions: [],
            inferences: [],
            transcript: [],
            startedAtMs: Date.now(),
            finishedAtMs: undefined,
            outcome: "running",
            failure: undefined,
            prompt: undefined,
            response: undefined,
        };
        this.traces.push(opened);
        return opened;
    }
}

/** The text blocks of a response, reassembled from its streamed deltas. */
export function textOf(inference: RealGymInference): string {
    let text = "";
    for (const { event } of inference.events) {
        if (event.type === "text_delta") text += event.delta;
    }
    return text;
}

/** The reasoning a response streamed, when the model shows any. */
export function reasoningOf(inference: RealGymInference): string {
    let text = "";
    for (const { event } of inference.events) {
        if (event.type === "reasoning_delta") text += event.delta;
    }
    return text;
}

/** Every tool the model called in one response, with the arguments it sent. */
export function toolCallsOf(
    inference: RealGymInference,
): readonly { readonly name: string; readonly args: string }[] {
    const names = new Map<string, string>();
    const calls: { name: string; args: string }[] = [];
    for (const { event } of inference.events) {
        if (event.type === "toolcall_start") names.set(event.callId, event.name);
        if (event.type === "toolcall_end") {
            calls.push({
                name: names.get(event.callId) ?? event.callId,
                args: event.arguments,
            });
        }
    }
    return calls;
}
