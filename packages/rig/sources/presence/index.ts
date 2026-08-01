export {
    AWAY_PRESENCE,
    AWAY_PRESENCE_ID,
    BUILT_IN_PRESENCES,
    ONLINE_PRESENCE,
    ONLINE_PRESENCE_ID,
} from "./builtInPresences.js";
export { createConfiguredPresenceStore } from "./createConfiguredPresenceStore.js";
export { describeUnansweredQuestion } from "./describeUnansweredQuestion.js";
export type { UnansweredQuestionDescription } from "./describeUnansweredQuestion.js";
export { PresenceStore } from "./PresenceStore.js";
export type { PresenceSelection, PresenceStoreOptions } from "./PresenceStore.js";
export { resolvePresences } from "./resolvePresences.js";
export type {
    Presence,
    PresenceAnswerOutcome,
    PresenceState,
    SetPresenceRequest,
} from "./types.js";
