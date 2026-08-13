/** Public surface of `@slopus/happy-agent-features`, re-exported by feature. */

// Goal: long-running work the agent keeps pursuing until it is complete or blocked.
export { GoalFeature, type GoalFeatureOptions } from "./goal/GoalFeature.js";
export { type GoalEvent, type GoalFeatureListener } from "./goal/GoalEvent.js";
export { createGoalTool } from "./goal/tools/create_goal.js";
export { getGoalTool } from "./goal/tools/get_goal.js";
export { updateGoalTool } from "./goal/tools/update_goal.js";
export {
    goalStatusSchema,
    sessionGoalSchema,
    type GoalStatus,
    type SessionGoal,
} from "./goal/SessionGoal.js";

// System prompt: the instructions each model is written for, chosen by the model in force.
export {
    SystemPromptFeature,
    type SystemPromptFeatureOptions,
} from "./systemPrompt/SystemPromptFeature.js";
export {
    DEFAULT_SYSTEM_PROMPT_IDENTITY,
    type SystemPromptIdentity,
} from "./systemPrompt/SystemPromptIdentity.js";
export { systemPromptForModel } from "./systemPrompt/impl/systemPromptForModel.js";

// History: the agent's own durable record of what happened, which it can read back.
export { HistoryFeature, type HistoryFeatureOptions } from "./history/HistoryFeature.js";
export {
    historyBlockSchema,
    historyMessageSchema,
    historyRoleSchema,
    type HistoryBlock,
    type HistoryMessage,
    type HistoryRole,
} from "./history/HistoryMessage.js";
export { type HistoryPage, type HistoryQuery } from "./history/HistoryPage.js";
export { type HistoryRecord, type HistoryStore } from "./history/HistoryStore.js";
export { readAgentHistoryTool } from "./history/tools/read_agent_history.js";
export {
    formatHistoryPage,
    MAX_HISTORY_CHARACTERS,
    type FormattedHistoryPage,
} from "./history/impl/formatHistoryPage.js";
export { formatHistoryMessage } from "./history/impl/formatHistoryMessage.js";
export { summarizeHistory, type HistoryStats } from "./history/impl/summarizeHistory.js";
export { selectHistoryPage } from "./history/impl/selectHistoryPage.js";

// Model switch: the notice a model gets when it inherits a conversation it cannot see.
export {
    ModelSwitchFeature,
    type ModelSwitchFeatureOptions,
} from "./modelSwitch/ModelSwitchFeature.js";
export {
    createModelSwitchNotice,
    type ModelSwitchNotice,
} from "./modelSwitch/impl/createModelSwitchNotice.js";
