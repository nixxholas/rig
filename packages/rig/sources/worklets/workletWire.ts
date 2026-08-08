/**
 * The worklet socket contract, owned by the SDK a worklet is built against.
 *
 * Rig validates every message with the same schemas the worklet encodes with, so the two halves
 * of the socket can never drift apart.
 */
export {
    emptyWorkletResponseSchema,
    registerWorkletToolsRequestSchema,
    registerWorkletToolsResponseSchema,
    workletCallCompletionSchema,
    workletEventSchema,
    workletReadyRequestSchema,
    workletStatusRequestSchema,
    workletToolRegistrationSchema,
    workletToolResultSchema,
} from "happy-worklets";

export type {
    RegisterWorkletToolsRequest,
    WorkletCallCompletion,
    WorkletEvent as WorkletStreamEvent,
    WorkletToolResult,
} from "happy-worklets";

import type { Static } from "@sinclair/typebox";
import { workletToolRegistrationSchema } from "happy-worklets";

export type WorkletToolRegistration = Static<typeof workletToolRegistrationSchema>;
