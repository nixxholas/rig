import {
    BaseProvider,
    BaseSession,
    type ProviderModality,
    type SessionCompaction,
    type SessionCompactionOptions,
    type SessionEvent,
    type SessionOptions,
    type SessionRunRequest,
    type SessionStream,
} from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

/** A fake session answering each run with the next scripted event batch, recording every request. */
export class ScriptedSession extends BaseSession {
    readonly requests: SessionRunRequest[] = [];
    readonly options: SessionOptions;

    readonly #script: SessionEvent[][];

    constructor(id: string, script: SessionEvent[][], options: SessionOptions) {
        super(id);
        this.#script = script;
        this.options = options;
    }

    run(_ctx: Context, request: SessionRunRequest): SessionStream {
        this.requests.push(request);
        const events = this.#script.shift() ?? [];
        return (async function* () {
            yield* events;
        })();
    }

    compact(_ctx: Context, _options: SessionCompactionOptions): Promise<SessionCompaction> {
        return Promise.reject(new Error("No scripted compaction result."));
    }

    destroy(): void {}
}

/** A fake provider whose sessions share one scripted event sequence, one batch per run. */
export class ScriptedProvider extends BaseProvider {
    static override readonly name = "scripted";
    static override readonly inputTypes: readonly ProviderModality[] = ["text"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];

    readonly sessions: ScriptedSession[] = [];

    readonly #script: SessionEvent[][];

    constructor(script: SessionEvent[][]) {
        super();
        this.#script = script;
    }

    session(id: string, options: SessionOptions): Promise<BaseSession> {
        const session = new ScriptedSession(id, this.#script, options);
        this.sessions.push(session);
        return Promise.resolve(session);
    }
}
