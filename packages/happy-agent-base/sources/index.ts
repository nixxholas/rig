/** Public surface of `@slopus/happy-agent-base`, re-exported by concern. */

// Agent instances and the collection that creates, resolves, and stores them.
export { Agent, type AgentOptions } from "./Agent.js";
export { type AgentSystem } from "./AgentSystem.js";
export { type AgentInitialContext } from "./AgentSystem.js";
export { AgentSystemLocal, type AgentSystemLocalOptions } from "./AgentSystemLocal.js";
export { AgentSystemRef } from "./AgentSystemRef.js";
export { AgentRef } from "./AgentRef.js";
export { agentSystem, withAgentSystem } from "./AgentSystemContext.js";

// Static agent configuration: environment, per-feature settings, and their context carrier.
export {
    agentConfig,
    agentConfigSchema,
    agentFeatureConfig,
    agentEnvironment,
    agentEnvironmentSchema,
    agentFeatureConfigSchema,
    agentPlatformSchema,
    currentAgentEnvironment,
    withAgentConfig,
    type AgentConfig,
    type AgentEnvironment,
    type AgentFeatureConfig,
    type AgentPlatform,
} from "./AgentConfig.js";
export { AgentStorage, type AgentStorageOptions } from "./AgentStorage.js";

// Provider/model routing and the curated model catalog.
export { type AgentModel } from "./AgentModel.js";
export { knownModels, type Model } from "./models.js";

// The run loop itself: its context carriers, key-value store, hook contracts, and persistence.
export {
    AgentBase,
    type AgentBaseAwaitOptions,
    type AgentBaseMessageOptions,
    type AgentBaseOptions,
    type AgentBaseQueueMode,
} from "./AgentBase.js";
export {
    agentEffort,
    agentId,
    agentKV,
    agentModel,
    agentProvider,
    agentRunKV,
    agentServiceTier,
    withAgentContext,
    withAgentKV,
    withAgentRunKV,
} from "./AgentContexts.js";
export {
    agentTaskContext,
    taskContextBeforeToolCall,
    withAgentTaskContext,
} from "./AgentTaskContext.js";
export { AgentKV } from "./AgentKV.js";
export {
    type AgentBaseHooks,
    type AgentBaseInference,
    type AgentBaseModelChange,
    type AgentBaseToolExecution,
    type AgentBaseTurn,
    type AgentBaseTurnStart,
    type MaybePromise,
} from "./AgentBaseHooks.js";
export { type AgentPersistence, type AgentRecord } from "./AgentPersistence.js";
export {
    agentBasePendingStateOf,
    agentBaseStoreOwesWork,
    AGENT_BASE_PENDING_KEY,
    type AgentBasePendingStage,
    type AgentBasePendingState,
} from "./AgentBasePending.js";
export { type AgentBaseState } from "./AgentBaseState.js";

// Features: pluggable capabilities that compose into an agent's hooks, tools, and instructions.
export {
    type AgentFeature,
    type AgentFeatureAgent,
    type AgentFeatureScope,
} from "./AgentFeature.js";
export { type AgentFeatureAction } from "./AgentFeatureAction.js";

// Registry of provider instances agents resolve their models through.
export { AgentProviders } from "./AgentProviders.js";

// Tool definitions.
export {
    defineAgentTool,
    type AgentTool,
    type AgentToolAutoPermissionActionDescriber,
    type AgentToolAutoPermissionPredicate,
    type AnyAgentTool,
} from "./AgentTool.js";
