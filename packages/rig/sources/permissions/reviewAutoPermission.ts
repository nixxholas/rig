import type { Message } from "../agent/types.js";
import {
    parseAutoPermissionReview,
    type AutoPermissionReview,
} from "./parseAutoPermissionReview.js";
import type { PermissionReviewAgent } from "./PermissionReviewAgent.js";
import { shouldAllowAutoPermissionReview } from "./shouldAllowAutoPermissionReview.js";
import { ABORTED_BY_SIGNAL, raceWithAbort } from "../utils/raceWithAbort.js";

/**
 * Wall-clock budget for one review, matching Codex. The reviewer may make as many tool calls as
 * it wants inside this window; when the window closes the action falls back to asking the user.
 */
export const AUTO_PERMISSION_REVIEW_TIMEOUT_MS = 90_000;

export async function reviewAutoPermission(options: {
    action: string;
    args: unknown;
    messages: readonly Message[];
    reviewer: PermissionReviewAgent;
    signal?: AbortSignal;
    timeoutMs?: number;
    toolName: string;
}): Promise<AutoPermissionReview> {
    if (options.signal?.aborted) throw new Error("Permission review was stopped.");
    const action = safeJson({
        description: options.action,
        tool: options.toolName,
        arguments: options.args,
    });
    const deadline = new AbortController();
    const timeout = setTimeout(
        () => deadline.abort(),
        options.timeoutMs ?? AUTO_PERMISSION_REVIEW_TIMEOUT_MS,
    );
    try {
        const response = await raceWithAbort(
            options.reviewer.review({
                action,
                messages: options.messages,
                signal: anySignal([options.signal, deadline.signal]),
            }),
            options.signal,
        );
        if (response === ABORTED_BY_SIGNAL) throw new Error("Permission review was stopped.");
        if (deadline.signal.aborted) return timedOutReview();
        const review = parseAutoPermissionReview(response.text);
        if (review?.decision === "allow") {
            // Routine low-risk work does not depend on historical authorization. Actions with
            // meaningful impact must still fail closed when that evidence is incomplete.
            if (response.userEvidenceOmitted && review.risk !== "low") {
                return incompleteUserEvidenceReview(review.risk);
            }
            if (!shouldAllowAutoPermissionReview(review)) {
                return { ...review, decision: "ask" };
            }
        }
        return (
            review ?? {
                decision: "ask",
                reason: "The automatic permission review returned an invalid decision.",
                risk: "medium",
                userAuthorization: "low",
            }
        );
    } catch (error) {
        if (options.signal?.aborted) throw error;
        return deadline.signal.aborted ? timedOutReview() : unavailableReview();
    } finally {
        clearTimeout(timeout);
    }
}

function anySignal(signals: readonly (AbortSignal | undefined)[]): AbortSignal {
    const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
    return present.length === 1 ? present[0]! : AbortSignal.any(present);
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

function unavailableReview(): AutoPermissionReview {
    return {
        decision: "ask",
        reason: "The automatic permission review could not make a reliable decision.",
        risk: "medium",
        userAuthorization: "low",
    };
}

function timedOutReview(): AutoPermissionReview {
    return {
        decision: "ask",
        reason: "The automatic permission review ran out of time.",
        risk: "medium",
        userAuthorization: "low",
    };
}

function incompleteUserEvidenceReview(risk: AutoPermissionReview["risk"]): AutoPermissionReview {
    return {
        decision: "ask",
        reason: "The full user authorization history did not fit in the automatic review.",
        risk,
        userAuthorization: "low",
    };
}
