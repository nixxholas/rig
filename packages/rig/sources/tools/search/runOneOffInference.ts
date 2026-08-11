import { createHash } from "node:crypto";

import { createId } from "@paralleldrive/cuid2";
import type { BaseProvider, SessionEvent, SessionTool } from "@slopus/happy-providers";

import type { OneOffInferenceRoute } from "./OneOffInferenceRoute.js";

/**
 * A search is a reasoning model running several rounds of queries before it writes an answer, so
 * a minute does not separate a slow search from a stuck one — it mostly cuts off work that was
 * about to succeed. The other bounded side calls in Rig already allow minutes.
 */
const DEFAULT_ONE_OFF_INFERENCE_TIMEOUT_MS = 5 * 60 * 1000;

export interface OneOffInferenceResult {
    durationMs: number;
    text: string;
}

/**
 * Runs one bounded provider request without creating an Executor or agent loop.
 *
 * The caller owns any vendor-specific event interpretation through `onEvent`. This helper only
 * opens the provider session, streams one request, collects text, and destroys the session.
 *
 * The request is never retried. A tool call is a step inside somebody's turn, so a provider that
 * quietly works through its retry budget spends minutes of that turn to arrive at the same answer,
 * and an account that is signed out or spent will never answer differently anyway. Failing at once
 * hands the model a real error it can act on, and it can simply search again if the failure was a
 * passing one.
 */
export async function runOneOffInference(options: {
    instructions: string;
    onEvent?: (event: SessionEvent) => void;
    prompt: string;
    route: OneOffInferenceRoute;
    signal?: AbortSignal;
    timeoutMs?: number;
    tools?: readonly SessionTool[];
}): Promise<OneOffInferenceResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_ONE_OFF_INFERENCE_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("One-off inference timeout must be a positive number of milliseconds.");
    }
    const native = await resolveNativeProvider(options.route);
    const session = await native.session(createOneOffSessionId(options.route), {
        inferenceMaxRetries: 0,
        instructions: options.instructions,
        tools: options.tools ?? [],
    });
    const controller = new AbortController();
    const abortFromCaller = () =>
        controller.abort(
            options.signal?.reason instanceof Error
                ? options.signal.reason
                : new Error("The one-off inference was cancelled."),
        );
    if (options.signal?.aborted === true) {
        abortFromCaller();
    } else {
        options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    }
    const timeout = setTimeout(
        () =>
            controller.abort(
                new Error(`The one-off inference timed out after ${String(timeoutMs)} ms.`),
            ),
        timeoutMs,
    );
    timeout.unref();
    const startedAt = performance.now();
    let text = "";
    try {
        const consume = async (): Promise<OneOffInferenceResult> => {
            for await (const event of session.run({
                abort: controller.signal,
                context: {
                    messages: [{ role: "user", content: options.prompt }],
                },
                ...(options.route.profile.defaultEffort === undefined
                    ? {}
                    : { effort: options.route.profile.defaultEffort }),
                model: options.route.profile.id,
            })) {
                options.onEvent?.(event);
                if (event.type === "text_delta") text += event.delta;
                if (event.type !== "done") continue;
                if (event.state === "cancelled") {
                    throw new Error("The one-off inference was cancelled.");
                }
                if (event.state === "error") {
                    throw new Error(event.message);
                }
                return {
                    durationMs: performance.now() - startedAt,
                    text: text.trim(),
                };
            }
            throw new Error("The one-off provider session ended without a final result.");
        };
        return await Promise.race([consume(), rejectWhenAborted(controller.signal)]);
    } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abortFromCaller);
        await session.destroy();
    }
}

async function resolveNativeProvider(route: OneOffInferenceRoute): Promise<BaseProvider> {
    return typeof route.provider.native === "function"
        ? route.provider.native(route.profile)
        : route.provider.native;
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
    return new Promise((_, reject) => {
        const rejectWithReason = () =>
            reject(
                signal.reason instanceof Error
                    ? signal.reason
                    : new Error("The one-off inference was cancelled."),
            );
        if (signal.aborted) {
            rejectWithReason();
            return;
        }
        signal.addEventListener("abort", rejectWithReason, { once: true });
    });
}

function createOneOffSessionId(route: OneOffInferenceRoute): string {
    const parentId = route.provider.sessionId ?? route.provider.id;
    const parentHash = createHash("sha256").update(parentId).digest("hex").slice(0, 16);
    return `one-off:${parentHash}:${createId()}`;
}
