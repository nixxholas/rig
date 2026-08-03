import { Value } from "@sinclair/typebox/value";

import {
    SERVICE_NOTICE_MESSAGE_MAX_LENGTH,
    SERVICE_NOTICE_TEXT_MAX_LENGTH,
    systemNoticePayloadSchema,
    type ComputePreparationEvent,
    type SystemNoticePayload,
} from "../protocol/index.js";

/** Builds the structured service notice and its required plain-text fallback together. */
export function formatComputePreparationNotice(
    event: ComputePreparationEvent,
): SystemNoticePayload {
    const { data } = event;
    const elapsed =
        data.elapsedMs === undefined ? "" : ` (${String(Math.round(data.elapsedMs / 1_000))}s)`;
    if (data.phase === "failed" || data.state === "failed") {
        const detail = data.message
            .replace(/^Compute (?:preparation|provisioning) failed[.:]?\s*/iu, "")
            .trim();
        return validateNotice({
            structured: structuredNotice(event),
            text: truncate(
                detail.length === 0
                    ? `Compute preparation failed.${elapsed}`
                    : `Compute preparation failed: ${detail}${elapsed}`,
                SERVICE_NOTICE_TEXT_MAX_LENGTH,
            ),
        });
    }
    const prefix =
        data.phase === "stopped" || data.state === "stopped"
            ? "Compute preparation stopped"
            : data.phase === "ready" || data.state === "ready"
              ? undefined
              : "Preparing compute";
    return validateNotice({
        structured: structuredNotice(event),
        text: truncate(
            `${prefix === undefined ? data.message : `${prefix}: ${data.message}`}${elapsed}`,
            SERVICE_NOTICE_TEXT_MAX_LENGTH,
        ),
    });
}

function structuredNotice(
    event: ComputePreparationEvent,
): NonNullable<SystemNoticePayload["structured"]> {
    const { data } = event;
    return {
        computeInstanceId: event.computeInstanceId,
        ...(data.elapsedMs === undefined ? {} : { elapsedMs: data.elapsedMs }),
        kind: "compute_preparation",
        message: truncate(data.message, SERVICE_NOTICE_MESSAGE_MAX_LENGTH),
        ...(data.percent === undefined ? {} : { percent: data.percent }),
        phase: data.phase,
        provider: data.provider,
        state: data.state,
    };
}

function validateNotice(payload: SystemNoticePayload): SystemNoticePayload {
    return Value.Decode(systemNoticePayloadSchema, payload);
}

function truncate(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : value.slice(0, maxLength);
}
