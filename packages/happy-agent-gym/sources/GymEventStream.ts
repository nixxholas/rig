import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";

/** One Server-Sent Event, kept as the daemon wrote it. */
export interface GymSseFrame {
    /** The durable event id the daemon assigned, when the frame carried one. */
    readonly id: string | undefined;
    /** The event name, which is the update type. */
    readonly event: string;
    /** The parsed JSON payload, or undefined when the frame was not JSON. */
    readonly data: unknown;
    /** The payload exactly as written. */
    readonly raw: string;
}

export interface GymEventStreamOptions {
    /** Replays from this durable cursor, the way a reconnecting client does. */
    readonly lastEventId?: string;
    /** How long a wait may take before it is reported as a failure. */
    readonly timeoutMs?: number;
}

interface GymEventStreamConstructorOptions extends GymEventStreamOptions {
    readonly path: string;
    readonly socketPath: string;
    readonly token: string;
}

/**
 * A live Server-Sent Events subscription, opened the way a client opens one.
 *
 * Frames are kept from the moment the stream opens, so a test may subscribe first, act, and then
 * wait for what its action should have produced without racing the daemon.
 */
export class GymEventStream {
    readonly #frames: GymSseFrame[] = [];
    readonly #waiters = new Set<() => void>();
    readonly #timeoutMs: number;
    readonly #opened: Promise<void>;
    #request: ClientRequest | undefined;
    #response: IncomingMessage | undefined;
    #failure: unknown;
    #closed = false;
    #buffer = "";

    constructor(options: GymEventStreamConstructorOptions) {
        this.#timeoutMs = options.timeoutMs ?? 10_000;
        this.#opened = new Promise<void>((resolve, reject) => {
            const call = httpRequest(
                {
                    headers: {
                        accept: "text/event-stream",
                        authorization: `Bearer ${options.token}`,
                        ...(options.lastEventId === undefined
                            ? {}
                            : { "last-event-id": options.lastEventId }),
                    },
                    method: "GET",
                    path: options.path,
                    socketPath: options.socketPath,
                },
                (response) => {
                    this.#response = response;
                    if ((response.statusCode ?? 0) !== 200) {
                        response.resume();
                        reject(
                            new Error(
                                `The Happy agent answered ${String(response.statusCode)} to ` +
                                    `${options.path}.`,
                            ),
                        );
                        return;
                    }
                    response.setEncoding("utf8");
                    response.on("data", (chunk: string) => this.#consume(chunk));
                    response.on("error", (error: unknown) => this.#fail(error));
                    response.on("end", () => this.#wake());
                    resolve();
                },
            );
            call.on("error", (error: unknown) => {
                this.#fail(error);
                reject(error);
            });
            call.end();
            this.#request = call;
        });
    }

    /** Resolves once the daemon has accepted the subscription. */
    async opened(): Promise<void> {
        await this.#opened;
    }

    /** Every frame received so far, oldest first. */
    get frames(): readonly GymSseFrame[] {
        return this.#frames;
    }

    /** The first frame matching `predicate`, including frames that arrived before this call. */
    async waitFor(
        predicate: (frame: GymSseFrame) => boolean,
        description = "a matching event",
        timeoutMs = this.#timeoutMs,
    ): Promise<GymSseFrame> {
        await this.#opened;
        const deadline = Date.now() + timeoutMs;
        let seen = 0;
        for (;;) {
            if (this.#failure !== undefined) throw this.#failure;
            while (seen < this.#frames.length) {
                const frame = this.#frames[seen];
                seen += 1;
                if (frame !== undefined && predicate(frame)) return frame;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new Error(
                    `Timed out after ${String(timeoutMs)}ms waiting for ${description}. ` +
                        `Received: ${this.#frames.map((frame) => frame.event).join(", ")}`,
                );
            }
            await this.#changed(remaining);
        }
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#response?.destroy();
        this.#request?.destroy();
        this.#wake();
    }

    #consume(chunk: string): void {
        this.#buffer += chunk;
        for (;;) {
            const boundary = this.#buffer.indexOf("\n\n");
            if (boundary === -1) return;
            const block = this.#buffer.slice(0, boundary);
            this.#buffer = this.#buffer.slice(boundary + 2);
            const frame = parseFrame(block);
            if (frame !== undefined) this.#frames.push(frame);
            this.#wake();
        }
    }

    #fail(error: unknown): void {
        if (this.#closed) return;
        this.#failure = error;
        this.#wake();
    }

    #wake(): void {
        // A waiter removes itself as it resolves, which a Set tolerates during its own iteration.
        for (const waiter of this.#waiters) waiter();
    }

    async #changed(timeoutMs: number): Promise<void> {
        await new Promise<void>((resolve) => {
            const finish = (): void => {
                clearTimeout(timer);
                this.#waiters.delete(finish);
                resolve();
            };
            const timer = setTimeout(finish, Math.min(timeoutMs, 50));
            timer.unref();
            this.#waiters.add(finish);
        });
    }
}

/**
 * The update a live frame carries.
 *
 * `/v0/events/live` names every frame `update` and wraps the durable event under `data.event`,
 * because that is the shape a Rig client consumes. `/v0/events/stream` instead names each frame
 * after the event's own type and carries the event directly.
 */
export function frameEvent(frame: GymSseFrame): Record<string, unknown> | undefined {
    const data = frame.data;
    if (data === null || typeof data !== "object") return undefined;
    const wrapped = (data as { readonly event?: unknown }).event;
    if (wrapped !== null && typeof wrapped === "object") {
        return wrapped as Record<string, unknown>;
    }
    return data as Record<string, unknown>;
}

function parseFrame(block: string): GymSseFrame | undefined {
    let id: string | undefined;
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
        if (line.length === 0 || line.startsWith(":")) continue;
        const separator = line.indexOf(":");
        const field = separator === -1 ? line : line.slice(0, separator);
        const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
        if (field === "id") id = value;
        else if (field === "event") event = value;
        else if (field === "data") data.push(value);
    }
    if (data.length === 0 && id === undefined) return undefined;
    const raw = data.join("\n");
    return { data: parseJson(raw), event, id, raw };
}

function parseJson(text: string): unknown {
    if (text.length === 0) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}
