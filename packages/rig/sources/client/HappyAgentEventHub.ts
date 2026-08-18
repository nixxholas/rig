import type { EventCursor, HappyAgentClient, HappyAgentEvent } from "@slopus/happy-agent-client";

const MAX_REPLAY_EVENTS = 1_000;
const RECONNECT_DELAY_MS = 100;

class EventGapError extends Error {}

interface EventFollower {
    fail(error: unknown): void;
    push(event: HappyAgentEvent): void;
}

/**
 * Rig's one global daemon event subscription.
 *
 * The hub keeps a small replay window so a mutation can answer with a cursor
 * before its caller begins waiting. Conversation settlement, title updates,
 * questions, and other live UI all fan out from this one ordered source.
 */
export class HappyAgentEventHub {
    readonly #client: HappyAgentClient;
    readonly #controller = new AbortController();
    #cursor: EventCursor;
    readonly #events: HappyAgentEvent[] = [];
    readonly #followers = new Set<EventFollower>();
    #pump: Promise<void> | undefined;

    constructor(client: HappyAgentClient, after: EventCursor) {
        this.#client = client;
        this.#cursor = after;
    }

    start(): void {
        this.#pump ??= this.#run();
    }

    async close(): Promise<void> {
        this.#controller.abort();
        await this.#pump?.catch(() => undefined);
    }

    /**
     * Replays everything after `after`, then follows live until `onEvent`
     * returns true or the signal is aborted.
     */
    follow(options: {
        after: EventCursor;
        onEvent: (event: HappyAgentEvent) => boolean | Promise<boolean>;
        signal?: AbortSignal;
    }): Promise<void> {
        this.start();
        return new Promise<void>((resolve, reject) => {
            let cursor = options.after;
            let settled = false;
            let chain = Promise.resolve();
            const finish = (error?: unknown) => {
                if (settled) return;
                settled = true;
                this.#followers.delete(follower);
                options.signal?.removeEventListener("abort", abort);
                if (error === undefined) resolve();
                else reject(error);
            };
            const consume = async (event: HappyAgentEvent) => {
                if (settled || event.cursor <= cursor) return;
                cursor = event.cursor;
                if (await options.onEvent(event)) finish();
            };
            const enqueue = (event: HappyAgentEvent) => {
                chain = chain.then(() => consume(event)).catch(finish);
            };
            const abort = () => finish();
            const follower: EventFollower = {
                fail: finish,
                push: enqueue,
            };
            this.#followers.add(follower);
            for (const event of this.#events) enqueue(event);
            if (options.signal?.aborted === true) finish();
            else options.signal?.addEventListener("abort", abort, { once: true });
        });
    }

    async #run(): Promise<void> {
        while (!this.#controller.signal.aborted) {
            try {
                for await (const frame of this.#client.streamEvents({
                    after: this.#cursor,
                    signal: this.#controller.signal,
                })) {
                    if (frame.kind === "hello") {
                        if (frame.hello.gap) {
                            throw new EventGapError(
                                "The daemon event cursor is no longer available; reload to resync.",
                            );
                        }
                        this.#cursor = frame.hello.cursor;
                        continue;
                    }
                    this.#cursor = frame.event.cursor;
                    this.#events.push(frame.event);
                    if (this.#events.length > MAX_REPLAY_EVENTS) this.#events.shift();
                    for (const follower of this.#followers) follower.push(frame.event);
                }
            } catch (error) {
                if (this.#controller.signal.aborted) break;
                // Transport interruption is exactly what the cursor is for:
                // reconnect and keep every waiter in place. A journal gap is
                // different—the snapshots behind those waiters are no longer
                // provably current, so they must surface the resync boundary.
                if (error instanceof EventGapError) {
                    for (const follower of this.#followers) follower.fail(error);
                }
            }
            if (!this.#controller.signal.aborted) {
                await delay(RECONNECT_DELAY_MS, this.#controller.signal);
            }
        }
    }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
        const finish = () => {
            signal.removeEventListener("abort", abort);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        const abort = () => {
            clearTimeout(timer);
            finish();
        };
        signal.addEventListener("abort", abort, { once: true });
        timer.unref();
    });
}
