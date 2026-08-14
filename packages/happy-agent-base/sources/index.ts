/** Public surface of `@slopus/happy-agent-base`, re-exported by concern. */

// Agent instances and the collection that creates, resolves, and stores them.
export { Agent, type AgentOptions } from "./Agent.js";
export { type AgentSystem } from "./AgentSystem.js";
export { type AgentCreateOptions, type AgentInitialContext } from "./AgentSystem.js";
export { AgentSystemLocal, type AgentSystemLocalOptions } from "./AgentSystemLocal.js";
export { AgentSystemRef } from "./AgentSystemRef.js";
export { AgentRef } from "./AgentRef.js";
export { agentSystem, withAgentSystem } from "./AgentSystemContext.js";

// Agent configuration: fixed environment/settings, mergeable metadata, and its context carrier.
export {
    agentConfig,
    agentConfigSchema,
    agentFeatureConfig,
    agentMetadata,
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
export {
    agentMessageMetadataSchema,
    agentMetadataSchema,
    agentMetadataValueSchema,
    cuid2Schema,
    type AgentMessageMetadata,
    type AgentMetadata,
    type AgentMetadataChange,
    type AgentMetadataValue,
} from "./AgentMetadata.js";
export { AgentStorage, type AgentStorageLock, type AgentStorageOptions } from "./AgentStorage.js";

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
    agentPermissionMode,
    agentProvider,
    agentRunKV,
    agentServiceTier,
    withAgentContext,
    withAgentKV,
    withAgentPermissionMode,
    withAgentRunKV,
} from "./AgentContexts.js";
export {
    agentPermissionModeLabel,
    agentPermissionModeSchema,
    isAgentPermissionMode,
    DEFAULT_AGENT_PERMISSION_MODE,
    type AgentPermissionMode,
} from "./AgentPermissionMode.js";
export {
    agentTaskContext,
    taskContextBeforeToolCall,
    withAgentTaskContext,
} from "./AgentTaskContext.js";
export { AgentKV } from "./AgentKV.js";
export {
    type AgentBaseAcceptedMessage,
    type AgentBaseHooks,
    type AgentBaseInference,
    type AgentBaseModelChange,
    type AgentBasePermissionModeChange,
    type AgentBasePersistedEvent,
    type AgentBaseToolCall,
    type AgentBaseToolCallDecision,
    type AgentBaseToolOutcome,
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

// Registry of provider sources agents resolve their selected models through.
export {
    AgentProviders,
    type AgentProviderSelection,
    type AgentProviderSource,
} from "./AgentProviders.js";

// Tool definitions.
export {
    defineAgentTool,
    type AgentTool,
    type AgentToolAutoPermissionActionDescriber,
    type AgentToolAutoPermissionPredicate,
    type AnyAgentTool,
} from "./AgentTool.js";
