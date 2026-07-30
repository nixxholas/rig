import type {
    ResponseErrorEvent,
    ResponseFailedEvent,
} from "openai/resources/responses/responses.js";

export function responseStreamError(
    event: ResponseErrorEvent | ResponseFailedEvent,
    failureMessage: string,
): Error & { code?: string } {
    if (event.type === "error") {
        return Object.assign(
            new Error(event.code === null ? event.message : `${event.code}: ${event.message}`),
            event.code === null ? {} : { code: event.code },
        );
    }
    return Object.assign(
        new Error(
            event.response.error?.message ??
                event.response.incomplete_details?.reason ??
                failureMessage,
        ),
        event.response.error === null || event.response.error === undefined
            ? {}
            : { code: event.response.error.code },
    );
}
