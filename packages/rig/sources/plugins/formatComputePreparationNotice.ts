import { Value } from "@sinclair/typebox/value";

import {
    SERVICE_NOTICE_MESSAGE_MAX_LENGTH,
    SERVICE_NOTICE_TEXT_MAX_LENGTH,
    systemNoticePayloadSchema,
    type ComputePreparationEvent,
    type SystemNoticePayload,
} from "../protocol/index.js";
import { formatComputeDuration } from "./formatComputeDuration.js";

/** Builds the structured service notice and its required plain-text fallback together. */
export function formatComputePreparationNotice(
    event: ComputePreparationEvent,
): SystemNoticePayload {
    const { data } = event;
    const elapsed =
        data.elapsedMs === undefined || data.elapsedMs < 1_000
            ? ""
            : ` (${formatComputeDuration(data.elapsedMs)})`;
    if (data.phase === "failed" || data.state === "failed") {
        const instanceLifecycle = /^Compute instance failed[.:]?\s*/iu.test(data.message);
        const detail = data.message
            .replace(/^Compute (?:instance|preparation|provisioning) failed[.:]?\s*/iu, "")
            .trim();
        const failed = instanceLifecycle ? "Compute instance failed" : "Compute preparation failed";
        return validateNotice({
            structured: structuredNotice(event),
            text: truncate(
                detail.length === 0 ? `${failed}.${elapsed}` : `${failed}: ${detail}${elapsed}`,
                SERVICE_NOTICE_TEXT_MAX_LENGTH,
            ),
        });
    }
    if (data.phase === "stopped" || data.state === "stopped") {
        const instanceLifecycle = /^Compute instance stopped[.:]?\s*/iu.test(data.message);
        const detail = data.message
            .replace(/^Compute (?:instance|preparation|provisioning) stopped[.:]?\s*/iu, "")
            .trim();
        const stopped = instanceLifecycle
            ? "Compute instance stopped"
            : "Compute preparation stopped";
        return validateNotice({
            structured: structuredNotice(event),
            text: truncate(
                detail.length === 0 ? `${stopped}.${elapsed}` : `${stopped}: ${detail}${elapsed}`,
                SERVICE_NOTICE_TEXT_MAX_LENGTH,
            ),
        });
    }
    if (data.state === "unavailable") {
        const detail = data.message
            .replace(
                /^(?:Compute instance unavailable|The compute instance is temporarily unavailable)[.:]?\s*/iu,
                "",
            )
            .trim();
        return validateNotice({
            structured: structuredNotice(event),
            text: truncate(
                detail.length === 0
                    ? `Compute instance unavailable.${elapsed}`
                    : `Compute instance unavailable: ${detail}${elapsed}`,
                SERVICE_NOTICE_TEXT_MAX_LENGTH,
            ),
        });
    }
    const prefix =
        data.phase === "ready" || data.state === "ready" ? undefined : "Preparing compute";
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
        ...(data.error === undefined
            ? {}
            : {
                  error: {
                      ...data.error,
                      message: truncate(data.error.message, SERVICE_NOTICE_MESSAGE_MAX_LENGTH),
                  },
              }),
        kind: "compute_preparation",
        ...(data.lastProgressAt === undefined ? {} : { lastProgressAt: data.lastProgressAt }),
        message: truncate(data.message, SERVICE_NOTICE_MESSAGE_MAX_LENGTH),
        ...(data.percent === undefined ? {} : { percent: data.percent }),
        phase: data.phase,
        provider: data.provider,
        ...(data.startedAt === undefined ? {} : { startedAt: data.startedAt }),
        state: data.state,
    };
}

function validateNotice(payload: SystemNoticePayload): SystemNoticePayload {
    return Value.Decode(systemNoticePayloadSchema, payload);
}

function truncate(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : value.slice(0, maxLength);
}
