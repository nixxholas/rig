import {
    workletInstallInputSchema,
    workletRevertInputSchema,
    workletUpdateInputSchema,
    type Worklet,
    type WorkletInstallInput,
    type WorkletRevertInput,
    type WorkletUpdateInput,
} from "@slopus/happy-agent-features";

import type { EventId } from "./EventId.js";

/** Rig's HTTP surface now accepts the feature's public operation inputs directly. */
export const installWorkletRequestSchema = workletInstallInputSchema;
export const updateWorkletRequestSchema = workletUpdateInputSchema;
export const revertWorkletRequestSchema = workletRevertInputSchema;

export type InstallWorkletRequest = WorkletInstallInput;
export type UpdateWorkletRequest = WorkletUpdateInput;
export type RevertWorkletRequest = WorkletRevertInput;
export type { Worklet };

export interface WorkletResponse {
    worklet: Worklet;
}

export interface ListWorkletsResponse {
    version: EventId;
    worklets: readonly Worklet[];
}

export interface WorkletLogResponse {
    log: string;
    truncated: boolean;
}

export type WorkletManagementErrorCode =
    | "invalid_request"
    | "invalid_worklet"
    | "worklet_not_found";

export interface WorkletManagementErrorResponse {
    error: {
        code: WorkletManagementErrorCode;
        message: string;
    };
}

export interface WorkletsChangedEvent {
    createdAt: number;
    data: {
        version: EventId;
        worklets: readonly Worklet[];
    };
    id: EventId;
    type: "worklets_changed";
}
