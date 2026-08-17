import {
    UserInputModule,
    type UserInputModuleOptions,
} from "../../sources/userInput/UserInputModule.js";
import type {
    UserInputAskInput,
    UserInputEvent,
    UserInputPresenceState,
    UserInputRequest,
} from "../../sources/userInput/index.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

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

export function createUserInputModule(options: UserInputTestOptions = {}): UserInputModule {
    let requestIndex = 0;
    let eventIndex = 0;
    let now = 100;
    return new UserInputModule({
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
