import type {
    DurableUserInputOptions,
    UserInputOutcome,
    UserInputRequest,
} from "../../user-input/index.js";

export interface CancelAskResult {
    cancelled: boolean;
    /** Why the question could not be withdrawn, when it could not be. */
    reason?: string;
}

export interface UserInputContext {
    /** Withdraws a question that is still waiting in the user's inbox. */
    cancel?(askId: string): Promise<CancelAskResult>;
    markExecuting?(requestId: string): Promise<void>;
    request(
        request: UserInputRequest,
        options?: { durable?: DurableUserInputOptions; signal?: AbortSignal },
    ): Promise<UserInputOutcome>;
}
