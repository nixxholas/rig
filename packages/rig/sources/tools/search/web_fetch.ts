import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import { networkToolPermission } from "../../runtime/networkToolPermission.js";
import type { OneOffInferenceRoute } from "./OneOffInferenceRoute.js";
import { runOneOffInference } from "./runOneOffInference.js";
import { getUrlMarkdownContent } from "./webFetch/getUrlMarkdownContent.js";
import { isPreapprovedWebFetchUrl } from "./webFetch/isPreapprovedWebFetchUrl.js";
import { makeWebFetchModelPrompt } from "./webFetch/makeWebFetchModelPrompt.js";
import type { WebFetchResponse } from "./webFetch/types.js";
import type { Context } from "@steve.kite/stdlib";

const MAX_WEB_FETCH_MARKDOWN_LENGTH = 100_000;

const webFetchResult = Type.Object({
    bytes: Type.Number(),
    code: Type.Number(),
    codeText: Type.String(),
    result: Type.String(),
    durationMs: Type.Number(),
    url: Type.String(),
});

export function createWebFetchTool(
    route?: OneOffInferenceRoute,
    dependencies: {
        fetchPage?: (url: string, signal?: AbortSignal) => Promise<WebFetchResponse>;
        now?: () => number;
        summarize?: (
            ctx: Context,
            prompt: string,
            markdown: string,
            route: OneOffInferenceRoute | undefined,
            signal: AbortSignal | undefined,
            isPreapprovedDomain: boolean,
        ) => Promise<string>;
    } = {},
) {
    const fetchPage = dependencies.fetchPage ?? getUrlMarkdownContent;
    const now = dependencies.now ?? Date.now;
    const summarize = dependencies.summarize ?? summarizeFetchedPage;
    return defineTool({
        name: "web_fetch",
        label: "Web fetch",
        description: `Fetch a public web page and answer one question about its contents.

Authenticated and private URLs are unsupported. The tool is read-only, follows only same-host
redirects automatically, and reports cross-host redirects for an explicit follow-up call.`,
        arguments: Type.Object(
            {
                url: Type.String({ description: "The fully qualified public URL to fetch" }),
                prompt: Type.String({
                    description: "What to extract or explain from the fetched page",
                }),
            },
            { additionalProperties: false },
        ),
        returnType: webFetchResult,
        ...networkToolPermission,
        describeAutoPermissionAction: ({ url }) =>
            `fetching ${quoteVisibleExact(url)}. Access: network access outside Rig’s shell sandbox`,
        execute: async ({ url, prompt }, _context, execution) => {
            try {
                new URL(url);
            } catch {
                throw new Error(`Invalid URL: ${url}`);
            }
            const startedAt = now();
            const response = await fetchPage(url, execution.signal);
            if ("type" in response) {
                const codeText = redirectStatusText(response.statusCode);
                const result = `REDIRECT DETECTED: The URL redirects to a different host.

Original URL: ${response.originalUrl}
Redirect URL: ${response.redirectUrl}
Status: ${response.statusCode} ${codeText}

Call web_fetch again with the redirect URL to continue.`;
                return {
                    bytes: Buffer.byteLength(result),
                    code: response.statusCode,
                    codeText,
                    durationMs: now() - startedAt,
                    result,
                    url,
                };
            }
            const preapproved = isPreapprovedWebFetchUrl(url);
            let result =
                preapproved &&
                response.contentType.includes("text/markdown") &&
                response.content.length < MAX_WEB_FETCH_MARKDOWN_LENGTH
                    ? response.content
                    : await summarize(
                          execution.ctx,
                          prompt,
                          response.content,
                          route,
                          execution.signal,
                          preapproved,
                      );
            if (response.persistedPath !== undefined) {
                result += `\n\n[Binary content (${response.contentType}, ${formatFileSize(response.persistedSize ?? response.bytes)}) also saved to ${response.persistedPath}]`;
            }
            return {
                bytes: response.bytes,
                code: response.code,
                codeText: response.codeText,
                durationMs: now() - startedAt,
                result,
                url,
            };
        },
        toLLM: (result) => [{ type: "text", text: result.result }],
        toUI: (result) =>
            `Received ${formatFileSize(result.bytes)} (${result.code} ${result.codeText})`,
        locks: [],
    });
}

async function summarizeFetchedPage(
    ctx: Context,
    prompt: string,
    markdown: string,
    route: OneOffInferenceRoute | undefined,
    signal: AbortSignal | undefined,
    isPreapprovedDomain: boolean,
): Promise<string> {
    if (route === undefined) {
        throw new Error(
            "web_fetch cannot summarize this page because no direct provider route is configured.",
        );
    }
    const truncated =
        markdown.length > MAX_WEB_FETCH_MARKDOWN_LENGTH
            ? `${markdown.slice(0, MAX_WEB_FETCH_MARKDOWN_LENGTH)}\n\n[Content truncated due to length...]`
            : markdown;
    const result = await runOneOffInference(ctx, {
        instructions:
            "Answer one question about a page already downloaded for you. Do not perform any other task.",
        prompt: makeWebFetchModelPrompt(truncated, prompt, isPreapprovedDomain),
        route,
        ...(signal === undefined ? {} : { signal }),
        tools: [],
    });
    return result.text.length === 0 ? "No response from model" : result.text;
}

function redirectStatusText(statusCode: number): string {
    if (statusCode === 301) return "Moved Permanently";
    if (statusCode === 307) return "Temporary Redirect";
    if (statusCode === 308) return "Permanent Redirect";
    return "Found";
}

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
