import {
    BaseProvider,
    BaseSession,
    type SessionCompaction,
    type SessionCompactionOptions,
    type SessionEvent,
    type SessionOptions,
    type SessionRunRequest,
    type SessionStream,
} from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type { RealGymInference, RealGymTrace } from "./RealGymTrace.js";

/**
 * A provider that records everything crossing the wire and otherwise stays out of the way. It
 * observes at the provider boundary rather than through agent hooks, so a trace shows exactly
 * the conversation the live model received and exactly the events it streamed back.
 */
export class TracingProvider extends BaseProvider {
    readonly #provider: BaseProvider;
    readonly #trace: RealGymTrace;

    constructor(provider: BaseProvider, trace: RealGymTrace) {
        super();
        this.#provider = provider;
        this.#trace = trace;
    }

    override get name(): string {
        return this.#provider.name;
    }

    override async session(id: string, options: SessionOptions): Promise<BaseSession> {
        // Session creation is where the modules' work becomes visible: the assembled system
        // prompt and the exact tool descriptors the model will be shown.
        this.#trace.sessions.push({
            instructions: options.instructions,
            tools: (options.tools ?? []).map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            })),
        });
        return new TracingSession(id, await this.#provider.session(id, options), this.#trace);
    }
}

class TracingSession extends BaseSession {
    readonly #session: BaseSession;
    readonly #trace: RealGymTrace;

    constructor(id: string, session: BaseSession, trace: RealGymTrace) {
        super(id);
        this.#session = session;
        this.#trace = trace;
    }

    override run(
        ctx: Parameters<BaseSession["run"]>[0],
        request: SessionRunRequest,
    ): SessionStream {
        const inference: RealGymInference = {
            model: request.model,
            effort: request.effort,
            serviceTier: request.serviceTier,
            messages: [...request.context.messages],
            events: [],
            startedAtMs: Date.now(),
            finishedAtMs: undefined,
            tokens: undefined,
            doneState: undefined,
            failure: undefined,
        };
        this.#trace.inferences.push(inference);
        return record(this.#session.run(ctx, request), inference);
    }

    override async compact(
        ctx: Parameters<BaseSession["compact"]>[0],
        options: SessionCompactionOptions,
    ): Promise<SessionCompaction> {
        return await this.#session.compact(ctx, options);
    }

    override async destroy(): Promise<void> {
        await this.#session.destroy();
    }
}

async function* record(stream: SessionStream, inference: RealGymInference): SessionStream {
    try {
        for await (const event of stream) {
            inference.events.push({ atMs: Date.now() - inference.startedAtMs, event });
            noteOutcome(event, inference);
            // A response is finished when its terminal event arrives; the stream's own
            // closure follows a moment later and must not be mistaken for the response time.
            if (event.type === "done") inference.finishedAtMs = Date.now();
            yield event;
        }
    } catch (error: unknown) {
        // A stream that throws never reaches the agent's own error handling as an event, so the
        // trace has to remember it before the failure travels on.
        inference.failure = error instanceof Error ? error.message : String(error);
        throw error;
    } finally {
        inference.finishedAtMs ??= Date.now();
    }
}

function noteOutcome(event: SessionEvent, inference: RealGymInference): void {
    if (event.type !== "done") return;
    inference.doneState = event.state;
    if (event.state === "error") {
        inference.failure = event.message;
        return;
    }
    if (event.state === "cancelled") return;
    inference.tokens = event.tokens;
}
