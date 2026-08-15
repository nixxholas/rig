import { createTimedSignal } from "./createTimedSignal.js";
import { describeWebFetchFailure } from "./describeWebFetchFailure.js";
import { isPermittedWebFetchRedirect } from "./isPermittedWebFetchRedirect.js";
import { readWebFetchResponse } from "./readWebFetchResponse.js";
import type { WebFetchRedirect } from "./types.js";

const FETCH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 10;
const REDIRECT_CODES = new Set([301, 302, 307, 308]);

export interface WebFetchHttpResponse {
    response: Response;
    raw: Buffer;
}

export async function getWithPermittedRedirects(
    url: string,
    signal?: AbortSignal,
    depth = 0,
): Promise<WebFetchHttpResponse | WebFetchRedirect> {
    if (depth > MAX_REDIRECTS) {
        throw new Error(`Too many redirects (exceeded ${MAX_REDIRECTS})`);
    }

    const timedSignal = createTimedSignal(signal, FETCH_TIMEOUT_MS);
    try {
        let response: Response;
        try {
            response = await fetch(url, {
                headers: {
                    Accept: "text/markdown, text/html, */*",
                    "User-Agent": "Claude-User (rig; +https://support.anthropic.com/)",
                },
                redirect: "manual",
                signal: timedSignal.signal,
            });
        } catch (error) {
            // A caller's own cancellation is not a failure to describe; it is what they asked for.
            if (signal?.aborted === true) throw error;
            throw new Error(describeWebFetchFailure(url, error), { cause: error });
        }

        if (REDIRECT_CODES.has(response.status)) {
            const location = response.headers.get("location");
            if (location === null) {
                throw new Error("Redirect response is missing a Location header");
            }
            const redirectUrl = new URL(location, url).toString();
            if (isPermittedWebFetchRedirect(url, redirectUrl)) {
                return getWithPermittedRedirects(redirectUrl, signal, depth + 1);
            }
            return {
                type: "redirect",
                originalUrl: url,
                redirectUrl,
                statusCode: response.status,
            };
        }

        if (!response.ok) {
            if (
                response.status === 403 &&
                response.headers.get("x-proxy-error") === "blocked-by-allowlist"
            ) {
                const domain = new URL(url).hostname;
                throw new Error(`Access to ${domain} is blocked by the network egress proxy.`);
            }
            const explained = response.statusText.trim();
            throw new Error(
                explained.length === 0
                    ? `${new URL(url).hostname} answered with HTTP ${String(response.status)}.`
                    : `${new URL(url).hostname} answered with HTTP ${String(response.status)} ${explained}.`,
            );
        }

        return { response, raw: await readWebFetchResponse(response) };
    } finally {
        timedSignal.dispose();
    }
}
