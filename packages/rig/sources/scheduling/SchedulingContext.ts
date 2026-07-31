import type {
    DurableWaitRequest,
    ScheduledMessage,
    ScheduleMessageRequest,
    WaitResult,
} from "./types.js";

export interface SchedulingContext {
    now(): number;
    scheduleMessage(request: ScheduleMessageRequest): ScheduledMessage;
    wait(request: DurableWaitRequest, signal?: AbortSignal): Promise<WaitResult>;
}
