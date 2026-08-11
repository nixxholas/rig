import type { SessionEvent } from "@/core/SessionEvent.js";

/**
 * Streams one server-tool result as start / optional delta / end.
 *
 * The result is opaque JSON or text the provider already produced. Empty results still close the
 * triple so a listener can pair every settled server call with a finished result when the caller
 * asks for that guarantee; callers that only care about content can ignore empty ends.
 */
export function* emitToolCallResult(
    callId: string,
    result: string,
    options: { incomplete?: boolean } = {},
): Generator<SessionEvent> {
    yield { type: "toolcall_result_start", callId };
    if (result.length > 0) {
        yield { type: "toolcall_result_delta", callId, delta: result };
    }
    yield {
        type: "toolcall_result_end",
        callId,
        result,
        ...(options.incomplete === true ? { incomplete: true as const } : {}),
    };
}
