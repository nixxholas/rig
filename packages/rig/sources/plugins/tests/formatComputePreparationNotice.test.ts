import { describe, expect, it } from "vitest";

import {
    SERVICE_NOTICE_MESSAGE_MAX_LENGTH,
    SERVICE_NOTICE_TEXT_MAX_LENGTH,
    type ComputePreparationEvent,
} from "../../protocol/index.js";
import { formatComputePreparationNotice } from "../formatComputePreparationNotice.js";

describe("formatComputePreparationNotice", () => {
    it("preserves classified failures, retryability, progress clocks, and unavailable state", () => {
        const event: ComputePreparationEvent = {
            computeInstanceId: "compute-1",
            createdAt: 50_000,
            data: {
                elapsedMs: 40_000,
                error: {
                    code: "preparing_compute",
                    elapsedMs: 40_000,
                    lastProgressAt: 20_000,
                    message: "The compute provider is recovering.",
                    percent: 45,
                    phase: "waiting_for_sandbox",
                    retryable: true,
                    startedAt: 10_000,
                    state: "unavailable",
                },
                lastProgressAt: 20_000,
                message: "The compute provider is recovering.",
                percent: 45,
                phase: "preparing_compute",
                provider: "cloud",
                startedAt: 10_000,
                state: "unavailable",
            },
            id: "event-1",
            type: "compute_preparation",
        };

        const payload = formatComputePreparationNotice(event);

        expect(payload.structured).toEqual({
            computeInstanceId: "compute-1",
            elapsedMs: 40_000,
            error: event.data.error,
            kind: "compute_preparation",
            lastProgressAt: 20_000,
            message: "The compute provider is recovering.",
            percent: 45,
            phase: "preparing_compute",
            provider: "cloud",
            startedAt: 10_000,
            state: "unavailable",
        });
        expect(payload.text).toBe(
            "Compute instance unavailable: The compute provider is recovering. (40s)",
        );
    });

    it("preserves a terminal classified failure without making it retryable", () => {
        const event: ComputePreparationEvent = {
            computeInstanceId: "compute-1",
            createdAt: 50_000,
            data: {
                error: {
                    code: "instance_failed",
                    message: "The compute provider disconnected.",
                    retryable: false,
                    state: "failed",
                },
                message: "The compute provider disconnected.",
                phase: "failed",
                provider: "cloud",
                state: "failed",
            },
            id: "event-1",
            type: "compute_preparation",
        };

        expect(formatComputePreparationNotice(event).structured?.error).toEqual(event.data.error);
    });

    it("truncates provider text before validating the durable notice payload", () => {
        const event: ComputePreparationEvent = {
            computeInstanceId: "compute-1",
            createdAt: 1,
            data: {
                message: "x".repeat(SERVICE_NOTICE_TEXT_MAX_LENGTH + 100),
                percent: 45,
                phase: "waiting_for_sandbox",
                provider: "cloud",
                state: "provisioning",
            },
            id: "event-1",
            type: "compute_preparation",
        };

        const payload = formatComputePreparationNotice(event);

        expect(payload.structured?.message).toHaveLength(SERVICE_NOTICE_MESSAGE_MAX_LENGTH);
        expect(payload.text).toHaveLength(SERVICE_NOTICE_TEXT_MAX_LENGTH);
    });

    it("bounds a classified error before validating the durable notice payload", () => {
        const event: ComputePreparationEvent = {
            computeInstanceId: "compute-1",
            createdAt: 1,
            data: {
                error: {
                    code: "instance_failed",
                    message: "x".repeat(SERVICE_NOTICE_MESSAGE_MAX_LENGTH + 100),
                    retryable: false,
                    state: "failed",
                },
                message: "Compute instance failed. Its maximum lifetime expired.",
                phase: "failed",
                provider: "cloud",
                state: "failed",
            },
            id: "event-1",
            type: "compute_preparation",
        };

        const payload = formatComputePreparationNotice(event);

        expect(payload.structured?.error).toMatchObject({
            code: "instance_failed",
            retryable: false,
            state: "failed",
        });
        expect(payload.structured?.error?.message).toHaveLength(SERVICE_NOTICE_MESSAGE_MAX_LENGTH);
        expect(payload.text).toBe("Compute instance failed: Its maximum lifetime expired.");
    });

    it("distinguishes stopping a ready instance from stopping preparation", () => {
        const event: ComputePreparationEvent = {
            computeInstanceId: "compute-1",
            createdAt: 1,
            data: {
                message: "Compute instance stopped. The user stopped it.",
                phase: "stopped",
                provider: "cloud",
                state: "stopped",
            },
            id: "event-1",
            type: "compute_preparation",
        };

        expect(formatComputePreparationNotice(event).text).toBe(
            "Compute instance stopped: The user stopped it.",
        );
    });

    it("does not repeat the registry's temporary-unavailability wording", () => {
        const event: ComputePreparationEvent = {
            computeInstanceId: "compute-1",
            createdAt: 1,
            data: {
                message: "The compute instance is temporarily unavailable. The provider timed out.",
                phase: "preparing_compute",
                provider: "cloud",
                state: "unavailable",
            },
            id: "event-1",
            type: "compute_preparation",
        };

        expect(formatComputePreparationNotice(event).text).toBe(
            "Compute instance unavailable: The provider timed out.",
        );
    });

    it("rejects malformed structured progress at the construction boundary", () => {
        const event: ComputePreparationEvent = {
            computeInstanceId: "compute-1",
            createdAt: 1,
            data: {
                message: "Waiting.",
                percent: 101,
                phase: "waiting_for_sandbox",
                provider: "cloud",
                state: "provisioning",
            },
            id: "event-1",
            type: "compute_preparation",
        };

        expect(() => formatComputePreparationNotice(event)).toThrow();
    });
});
