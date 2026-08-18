import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";

/**
 * Adapt one real Unix-domain HTTP socket to the standard Fetch API.
 *
 * The HappyAgentClient deliberately knows nothing about local transports. This
 * adapter is the harness boundary: all ordinary JSON and SSE requests still
 * travel through the public client, while only the socket path is specific to
 * the gym.
 */
export function createUnixSocketFetch(socketPath: string): typeof globalThis.fetch {
    return async (input, init = {}) => {
        const source = input instanceof Request ? input : undefined;
        const url = new URL(source?.url ?? String(input));
        const headers = new Headers(source?.headers);
        new Headers(init.headers).forEach((value, name) => headers.set(name, value));
        const signal = init.signal ?? source?.signal;
        const body = init.body;

        if (
            body !== undefined &&
            body !== null &&
            typeof body !== "string" &&
            !(body instanceof Uint8Array) &&
            !(body instanceof ArrayBuffer) &&
            !(body instanceof URLSearchParams)
        ) {
            throw new TypeError("Unix-socket fetch supports buffered request bodies.");
        }

        return await new Promise<Response>((resolve, reject) => {
            if (signal?.aborted === true) {
                reject(signal.reason ?? new DOMException("The request was aborted.", "AbortError"));
                return;
            }

            const request = httpRequest({
                headers: Object.fromEntries(headers),
                method: init.method ?? source?.method ?? "GET",
                path: `${url.pathname}${url.search}`,
                socketPath,
            });
            let settled = false;
            let responseStream: import("node:http").IncomingMessage | undefined;
            const abort = (): void => {
                const reason =
                    signal?.reason instanceof Error
                        ? signal.reason
                        : new DOMException("The request was aborted.", "AbortError");
                request.destroy(reason);
                responseStream?.destroy(reason);
            };
            signal?.addEventListener("abort", abort, { once: true });
            request.once("error", (error) => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener("abort", abort);
                reject(error);
            });
            request.once("response", (response) => {
                if (settled) return;
                settled = true;
                responseStream = response;
                const responseHeaders = new Headers();
                for (const [name, value] of Object.entries(response.headers)) {
                    for (const item of Array.isArray(value) ? value : [value]) {
                        if (item !== undefined) responseHeaders.append(name, String(item));
                    }
                }
                response.once("close", () => signal?.removeEventListener("abort", abort));
                const status = response.statusCode ?? 500;
                resolve(
                    new Response(
                        status === 204 || status === 205 || status === 304
                            ? null
                            : (Readable.toWeb(response) as ReadableStream<Uint8Array>),
                        {
                            headers: responseHeaders,
                            status,
                            ...(response.statusMessage === undefined
                                ? {}
                                : { statusText: response.statusMessage }),
                        },
                    ),
                );
            });

            if (body === undefined || body === null) {
                request.end();
            } else if (body instanceof URLSearchParams) {
                request.end(body.toString());
            } else if (body instanceof ArrayBuffer) {
                request.end(Buffer.from(body));
            } else {
                request.end(body);
            }
        });
    };
}
