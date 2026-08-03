import { describe, expect, it } from "vitest";

import {
    SERVICE_NOTICE_MESSAGE_MAX_LENGTH,
    SERVICE_NOTICE_TEXT_MAX_LENGTH,
    type ComputePreparationEvent,
} from "../../protocol/index.js";
import { formatComputePreparationNotice } from "../formatComputePreparationNotice.js";

describe("formatComputePreparationNotice", () => {
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
