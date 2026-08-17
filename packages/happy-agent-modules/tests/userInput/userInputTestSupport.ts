import type { Context } from "@steve.kite/stdlib";

import {
    UserInputModule,
    type UserInputModuleOptions,
} from "../../sources/userInput/UserInputModule.js";
import type {
    UserInputAskInput,
    UserInputEvent,
    UserInputPresenceState,
    UserInputRequest,
    UserInputTerminalRequest,
} from "../../sources/userInput/index.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

export class UserInputTestBroker {
    readonly calls: string[] = [];
    readonly contexts: Context[] = [];
    readonly options: Array<{ readonly timeoutAt?: number }> = [];
    readonly #waiters = new Map<
        string,
        {
            readonly resolve: (request: UserInputTerminalRequest) => void;
            readonly reject: (error: unknown) => void;
        }
    >();

    async wait(
        ctx: Context,
        _agentId: string,
        requestId: string,
        options?: { readonly timeoutAt?: number },
    ): Promise<UserInputTerminalRequest> {
        this.calls.push(requestId);
        this.contexts.push(ctx);
        this.options.push(options ?? {});
        return await new Promise<UserInputTerminalRequest>((resolve, reject) => {
            this.#waiters.set(requestId, { resolve, reject });
        });
    }

    settle(request: UserInputTerminalRequest): void {
        const waiter = this.#waiters.get(request.id);
        if (waiter === undefined) throw new Error(`No waiter for ${request.id}`);
        this.#waiters.delete(request.id);
        waiter.resolve(structuredClone(request));
    }

    reject(requestId: string, error: unknown): void {
        const waiter = this.#waiters.get(requestId);
        if (waiter === undefined) throw new Error(`No waiter for ${requestId}`);
        this.#waiters.delete(requestId);
        waiter.reject(error);
    }
}

export interface UserInputTestOptions {
    readonly listener?: UserInputModuleOptions["listener"];
    readonly presence?: UserInputModuleOptions["presence"];
    readonly authorization?: UserInputModuleOptions["authorization"];
    readonly idFactory?: UserInputModuleOptions["idFactory"];
    readonly eventIdFactory?: UserInputModuleOptions["eventIdFactory"];
    readonly clock?: UserInputModuleOptions["clock"];
    readonly onPostCommitError?: UserInputModuleOptions["onPostCommitError"];
    readonly maxPageSize?: number;
    readonly maxOutputCharacters?: number;
    readonly maxQuestionCharacters?: number;
    readonly maxContextCharacters?: number;
    readonly maxAnswerCharacters?: number;
    readonly maxOptionCount?: number;
    readonly maxOptionLabelCharacters?: number;
    readonly maxOptionDescriptionCharacters?: number;
    readonly maxCancelReasonCharacters?: number;
    readonly maxDetailPageCharacters?: number;
}

export function createUserInputModule(
    broker: UserInputTestBroker,
    options: UserInputTestOptions = {},
): UserInputModule {
    let requestIndex = 0;
    let eventIndex = 0;
    let now = 100;
    return new UserInputModule({
        broker,
        idFactory: () => `request-${String(++requestIndex)}`,
        eventIdFactory: () => `event-${String(++eventIndex)}`,
        clock: () => ++now,
        ...options,
    } as UserInputModuleOptions);
}

export function createUserInputDatabase(
    module: UserInputModule,
    name: string,
): ModuleDatabase & { readonly database: import("@slopus/happy-agent-base").AgentDatabase } {
    return moduleDatabase(module.migrations, name);
}

export function singularAsk(overrides: Partial<UserInputAskInput> = {}): UserInputAskInput {
    return {
        question: "Which option should I use?",
        context: "The choice changes the implementation.",
        ...overrides,
    } as UserInputAskInput;
}

export function onlinePresence(
    overrides: Partial<UserInputPresenceState> = {},
): UserInputPresenceState {
    return {
        answerWaitMs: null,
        title: "Online",
        emoji: "🟢",
        prompt: "The user can answer.",
        ...overrides,
    };
}

export async function createRequest(
    database: ModuleDatabase,
    module: UserInputModule,
    agentId: string,
    input: UserInputAskInput = singularAsk(),
    requestId = "request-1",
): Promise<UserInputRequest> {
    await database.ready;
    return await module.ask(database.context, agentId, input, requestId);
}

export function eventTypes(events: readonly UserInputEvent[]): readonly string[] {
    return events.map((event) => event.type);
}
