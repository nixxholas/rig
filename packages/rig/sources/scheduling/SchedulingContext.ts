import type {
    DurableWaitRequest,
    ScheduledMessage,
    ScheduleMessageRequest,
    WaitResult,
} from "./types.js";

export interface SchedulingContext {
    now(): number;
    scheduleMessage(request: ScheduleMessageRequest): Promise<ScheduledMessage>;
    wait(request: DurableWaitRequest, signal?: AbortSignal): Promise<WaitResult>;
}
