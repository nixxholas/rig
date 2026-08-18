import { request as httpRequest, type IncomingHttpHeaders } from "node:http";

import { GymEventStream, type GymEventStreamOptions } from "./GymEventStream.js";

/** One answer from the daemon, kept whole so a test can assert the status a route really chose. */
export interface GymHttpResponse<Body = unknown> {
    readonly status: number;
    readonly headers: IncomingHttpHeaders;
    /** The response body as text, always present even when it is not JSON. */
    readonly text: string;
    /** The parsed JSON body, or undefined when the response was not JSON. */
    readonly body: Body;
}

export interface GymHttpClientOptions {
    readonly socketPath: string;
    readonly token: string;
    /** How long one request may take before it is treated as a failure. */
    readonly timeoutMs?: number;
}

/**
 * A deliberately raw Unix-socket probe.
 *
 * Ordinary JSON and SSE scenarios use `HappyAgentClient`; this escape hatch is
 * reserved for exact authentication/header/unknown-route assertions where a
 * typed client intentionally has no method. It never throws on unsuccessful
 * statuses so those probes can inspect the daemon's complete answer.
 */
export class GymHttpClient {
    readonly socketPath: string;
    readonly token: string;
    readonly #timeoutMs: number;

    constructor(options: GymHttpClientOptions) {
        this.socketPath = options.socketPath;
        this.token = options.token;
        this.#timeoutMs = options.timeoutMs ?? 20_000;
    }

    async request<Body = unknown>(
        method: string,
        path: string,
        body?: unknown,
    ): Promise<GymHttpResponse<Body>> {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
        return await new Promise<GymHttpResponse<Body>>((resolve, reject) => {
            const call = httpRequest(
                {
                    headers: {
                        accept: "application/json",
                        authorization: `Bearer ${this.token}`,
                        ...(payload === undefined
                            ? {}
                            : {
                                  "content-length": String(payload.byteLength),
                                  "content-type": "application/json",
                              }),
                    },
                    method,
                    path,
                    socketPath: this.socketPath,
                },
                (response) => {
                    const chunks: Buffer[] = [];
                    response.on("data", (chunk: Buffer) => chunks.push(chunk));
                    response.on("error", reject);
                    response.on("end", () => {
                        const text = Buffer.concat(chunks).toString("utf8");
                        resolve({
                            body: parseJson(text) as Body,
                            headers: response.headers,
                            status: response.statusCode ?? 0,
                            text,
                        });
                    });
                },
            );
            call.setTimeout(this.#timeoutMs, () => {
                call.destroy(
                    new Error(`The Happy agent did not answer ${method} ${path} in time.`),
                );
            });
            call.on("error", reject);
            if (payload !== undefined) call.write(payload);
            call.end();
        });
    }

    async get<Body = unknown>(path: string): Promise<GymHttpResponse<Body>> {
        return await this.request<Body>("GET", path);
    }

    async post<Body = unknown>(path: string, body?: unknown): Promise<GymHttpResponse<Body>> {
        return await this.request<Body>("POST", path, body ?? {});
    }

    async put<Body = unknown>(path: string, body?: unknown): Promise<GymHttpResponse<Body>> {
        return await this.request<Body>("PUT", path, body ?? {});
    }

    async patch<Body = unknown>(path: string, body?: unknown): Promise<GymHttpResponse<Body>> {
        return await this.request<Body>("PATCH", path, body ?? {});
    }

    async delete<Body = unknown>(path: string, body?: unknown): Promise<GymHttpResponse<Body>> {
        return await this.request<Body>("DELETE", path, body);
    }

    /** The body of a request that had to succeed, with the daemon's own words when it did not. */
    async ok<Body = unknown>(method: string, path: string, body?: unknown): Promise<Body> {
        const response = await this.request<Body>(method, path, body);
        if (response.status < 200 || response.status >= 300) {
            throw new Error(
                `The Happy agent answered ${String(response.status)} to ${method} ${path}: ` +
                    response.text,
            );
        }
        return response.body;
    }

    /** Open one Server-Sent Events stream, such as `/v0/events/stream`. */
    stream(path: string, options: GymEventStreamOptions = {}): GymEventStream {
        return new GymEventStream({
            path,
            socketPath: this.socketPath,
            token: this.token,
            ...options,
        });
    }
}

function parseJson(text: string): unknown {
    if (text.length === 0) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}
