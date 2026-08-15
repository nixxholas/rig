/** Public surface of `@slopus/happy-agent-modules`, re-exported by module. */

// Goal: long-running work the agent keeps pursuing until it is complete or blocked.
export {
    GoalModule,
    assertGoalModuleOptions,
    goalModuleOptionsSchema,
    FAILED_TURNS_BEFORE_BLOCKED,
    type GoalModuleOptions,
} from "./goal/GoalModule.js";
export {
    goalEventSchema,
    goalContextSchema,
    goalModuleListenerSchema,
    type GoalEvent,
    type GoalModuleListener,
} from "./goal/GoalEvent.js";
export { createGoalTool } from "./goal/tools/create_goal.js";
export { clearGoalTool } from "./goal/tools/clear_goal.js";
export { getGoalTool } from "./goal/tools/get_goal.js";
export { updateGoalTool } from "./goal/tools/update_goal.js";
export {
    goalAgentIdSchema,
    goalMutationOptionsSchema,
    goalMutationProofSchema,
    goalMutationResultSchema,
    goalObjectiveSchema,
    goalOperationFingerprintSchema,
    goalOperationIdSchema,
    goalOperationIdentitySchema,
    goalOperationRequestSchema,
    goalOperationReceiptSchema,
    goalOperationSchema,
    goalStatusSchema,
    goalSetInputSchema,
    goalStatusInputSchema,
    goalClearInputSchema,
    goalTimestampSchema,
    MAX_GOAL_AGENT_ID_LENGTH,
    MAX_GOAL_EVIDENCE_BYTES,
    MAX_GOAL_LEDGER_BYTES,
    MAX_GOAL_OBJECTIVE_CHARS,
    MAX_GOAL_OPERATION_ID_LENGTH,
    MAX_GOAL_OUTPUT_CHARACTERS,
    MAX_GOAL_RECEIPTS,
    sessionGoalSchema,
    type GoalAgentId,
    type GoalMutationOptions,
    type GoalMutationProof,
    type GoalMutationResult,
    type GoalOperationFingerprint,
    type GoalOperationId,
    type GoalOperationIdentity,
    type GoalOperation,
    type GoalOperationRequest,
    type GoalOperationReceipt,
    type GoalStatus,
    type SessionGoal,
} from "./goal/SessionGoal.js";
export {
    createGoalContinuationPrompt,
    goalContinuationPromptSchema,
    MAX_GOAL_CONTINUATION_PROMPT_CHARS,
    type GoalContinuationPrompt,
} from "./goal/impl/createGoalContinuationPrompt.js";
export { formatGoalForModel } from "./goal/impl/formatGoalForModel.js";

// System prompt: the instructions each model is written for, chosen by the model in force.
export {
    SystemPromptModule,
    MAX_SYSTEM_PROMPT_OUTPUT_BYTES,
    systemPromptModuleOptionsSchema,
    systemPromptIdentitySchema,
    systemPromptSelectionSchema,
    type SystemPromptModuleOptions,
    type SystemPromptSelection,
} from "./systemPrompt/SystemPromptModule.js";
export {
    DEFAULT_SYSTEM_PROMPT_IDENTITY,
    MAX_SYSTEM_PROMPT_IDENTITY_NAME_LENGTH,
    MAX_SYSTEM_PROMPT_IDENTITY_PROMPT_LENGTH,
    type SystemPromptIdentity,
} from "./systemPrompt/SystemPromptIdentity.js";
export {
    MAX_SYSTEM_PROMPT_MODEL_LENGTH,
    systemPromptProviderKindSchema,
    type SystemPromptProviderKind,
} from "./systemPrompt/SystemPromptSelection.js";
export { systemPromptForModel } from "./systemPrompt/impl/systemPromptForModel.js";

// History: the agent's own durable record of what happened, which it can read back.
export {
    HistoryModule,
    historyModuleOptionsSchema,
    type HistoryModuleOptions,
} from "./history/HistoryModule.js";
export {
    historyAgentIdSchema,
    historyBlockSchema,
    historyImageBlockSchema,
    historyMessageSchema,
    historyMessageInputSchema,
    historyModelSchema,
    historyProviderSchema,
    historyRecordIdSchema,
    historyRoleSchema,
    historyTextBlockSchema,
    historyThinkingBlockSchema,
    historyTimestampSchema,
    historyToolArgumentsSchema,
    historyToolCallBlockSchema,
    historyToolResultBlockSchema,
    MAX_HISTORY_AGENT_ID_LENGTH,
    MAX_HISTORY_ARGUMENT_ARRAY_ITEMS,
    MAX_HISTORY_ARGUMENT_BYTES,
    MAX_HISTORY_ARGUMENT_DEPTH,
    MAX_HISTORY_ARGUMENT_KEY_LENGTH,
    MAX_HISTORY_ARGUMENT_OBJECT_PROPERTIES,
    MAX_HISTORY_ARGUMENT_STRING_LENGTH,
    MAX_HISTORY_BLOCKS_PER_PAGE,
    MAX_HISTORY_BLOCKS_PER_MESSAGE,
    MAX_HISTORY_CALL_ID_LENGTH,
    MAX_HISTORY_MEDIA_TYPE_LENGTH,
    MAX_HISTORY_MESSAGES_PER_APPEND,
    MAX_HISTORY_MODEL_LENGTH,
    MAX_HISTORY_MESSAGE_JSON_BYTES,
    MAX_HISTORY_PAGE_SIZE,
    MAX_HISTORY_PENDING_BLOCKS,
    MAX_HISTORY_POSITION,
    MAX_HISTORY_PROVIDER_LENGTH,
    MAX_HISTORY_QUERY_LENGTH,
    MAX_HISTORY_RECORD_ID_LENGTH,
    MAX_HISTORY_TEXT_LENGTH,
    MAX_HISTORY_THINKING_LENGTH,
    MAX_HISTORY_TOOL_DISPLAY_LENGTH,
    MAX_HISTORY_TOOL_NAME_LENGTH,
    MAX_HISTORY_TOOL_OUTPUT_LENGTH,
    MAX_HISTORY_TOTAL_MESSAGES,
    MAX_HISTORY_TOTAL_BLOCKS,
    MAX_HISTORY_TOTAL_TEXT_CHARACTERS,
    type HistoryBlock,
    type HistoryMessage,
    type HistoryMessageInput,
    type HistoryRole,
    historyMessageWithinPersistenceBounds,
    historyToolArgumentsWithinByteLimit,
} from "./history/HistoryMessage.js";
export {
    historyPageSchema,
    historyQuerySchema,
    type HistoryPage,
    type HistoryQuery,
} from "./history/HistoryPage.js";
export {
    historyContextSchema,
    historyRecordSchema,
    historyStoreSchema,
    historyStoreQuerySchema,
    type HistoryRecord,
    type HistoryStore,
    type HistoryStoreQuery,
} from "./history/HistoryStore.js";
export { readAgentHistoryTool } from "./history/tools/read_agent_history.js";
export {
    formatHistoryPage,
    MAX_HISTORY_CHARACTERS,
    type FormattedHistoryPage,
} from "./history/impl/formatHistoryPage.js";
export { formatHistoryMessage } from "./history/impl/formatHistoryMessage.js";
export {
    historyStatsSchema,
    summarizeHistory,
    type HistoryStats,
} from "./history/impl/summarizeHistory.js";
export {
    foldHistorySearchText,
    historyMessageSearchParts,
    messageMatchesHistoryFilters,
} from "./history/impl/messageMatchesHistoryFilters.js";
export { selectHistoryPage } from "./history/impl/selectHistoryPage.js";

// Compute: the machine an agent works on, as file and command tools over one compute.
export {
    ComputeModule,
    agentComputeConfigSchema,
    computeModuleOptionsSchema,
    hostComputeSchema,
    type AgentComputeConfig,
    type ComputeModuleOptions,
    type HostCompute,
    type HostComputeProvider,
} from "./compute/ComputeModule.js";
export {
    createComputeModules,
    type CreatedComputeModules,
} from "./compute/createComputeModules.js";
export { type ComputeResolver } from "./compute/ComputeResolver.js";
export {
    type Compute,
    type ComputeFileStat,
    type ComputeFileSystem,
    type ComputePermissions,
    type ComputeRunOptions,
    type ComputeSessionActivity,
    type ComputeSessionReadOptions,
    type ComputeSessionSnapshot,
    type ComputeSessionStatus,
    type ComputeShell,
} from "./compute/Compute.js";
export { readFileTool } from "./compute/tools/read_file.js";
export { writeFileTool } from "./compute/tools/write_file.js";
export { editFileTool } from "./compute/tools/edit_file.js";
export { listDirectoryTool } from "./compute/tools/list_directory.js";
export { findFilesTool } from "./compute/tools/find_files.js";
export { searchFilesTool } from "./compute/tools/search_files.js";
export { runCommandTool } from "./compute/tools/run_command.js";
export { readCommandOutputTool } from "./compute/tools/read_command_output.js";
export { sendCommandInputTool } from "./compute/tools/send_command_input.js";
export { stopCommandTool } from "./compute/tools/stop_command.js";
export {
    commandResultSchema,
    createCommandResult,
    formatCommandResult,
    type CommandResult,
} from "./compute/impl/commandResult.js";
export { FileReadLog } from "./compute/impl/FileReadLog.js";

// Model switch: the notice a model gets when it inherits a conversation it cannot see.
export {
    ModelSwitchModule,
    modelSwitchModuleOptionsSchema,
    type ModelSwitchModuleOptions,
} from "./modelSwitch/ModelSwitchModule.js";
export {
    createModelSwitchNotice,
    type ModelSwitchNotice,
} from "./modelSwitch/impl/createModelSwitchNotice.js";

// Permissions: the mode an agent runs in, enforced call by call.
export {
    PermissionsModule,
    type PermissionsModuleOptions,
} from "./permissions/PermissionsModule.js";
export {
    type PermissionEvent,
    type PermissionModuleListener,
} from "./permissions/PermissionEvent.js";
export {
    type PermissionReviewDecision,
    type PermissionReviewer,
    type PermissionReviewRequest,
} from "./permissions/PermissionReviewer.js";
export {
    permissionModeChangeNotice,
    permissionModeGuidance,
} from "./permissions/impl/permissionModeGuidance.js";

// Presence: host-owned current status, temporary fallbacks, and optional recurring windows.
export {
    PresenceModule,
    presenceModuleOptionsSchema,
    presenceMutationOptionsSchema,
    type PresenceModuleOptions,
    type PresenceMutationOptions,
} from "./presence/PresenceModule.js";
export {
    presenceEventSchema,
    presenceModuleListenerSchema,
    presenceContextSchema,
    type PresenceEvent,
    type PresenceModuleListener,
} from "./presence/PresenceEvent.js";
export {
    presenceScheduleInputSchema,
    presenceScheduleSchema,
    assertPresenceSchedule,
    assertPresenceScheduleInput,
    type PresenceSchedule,
    type PresenceScheduleInput,
} from "./presence/PresenceSchedule.js";
export {
    assertPresenceState,
    assertPresenceToolInput,
    assertTemporaryPresenceInput,
    presenceFallbackSchema,
    presenceStateSchema,
    presenceStatusSchema,
    presenceToolInputSchema,
    temporaryPresenceInputSchema,
    type PresenceFallback,
    type PresenceState,
    type PresenceStatus,
    type PresenceToolInput,
    type TemporaryPresenceInput,
} from "./presence/PresenceState.js";
export {
    assertPresenceContext,
    assertPresenceMutationReceipt,
    assertPresenceScheduleResult,
    assertPresenceStateResult,
    assertPresenceTransactionChange,
    assertPresenceVoidResult,
    presenceFingerprintSchema,
    presenceMutationReceiptSchema,
    presenceOperationIdSchema,
    presenceReaderSchema,
    presenceScheduleStoreSchema,
    presenceStoreSchema,
    presenceTransactionChangeSchema,
    type PresenceReader,
    type PresenceScheduleStore,
    type PresenceMutationReceipt,
    type PresenceStore,
    type PresenceTransactionChange,
} from "./presence/PresenceStore.js";
export { getPresenceTool } from "./presence/tools/get_presence.js";
export { setPresenceTool } from "./presence/tools/set_presence.js";

// Tasks: a bounded persistent todo list owned by the module.
export {
    TasksModule,
    DEFAULT_MAX_TASKS,
    DEFAULT_TASK_PRIORITY,
    MAX_TASKS,
    assertTasksModuleOptions,
    tasksModuleOptionsSchema,
    type TasksModuleOptions,
} from "./tasks/TasksModule.js";
export {
    taskCreateInputSchema,
    taskDetailSchema,
    taskIdSchema,
    taskPrioritySchema,
    taskSchema,
    taskStatusSchema,
    taskTimestampSchema,
    taskTitleSchema,
    taskUpdateInputSchema,
    type Task,
    type TaskCreateInput,
    type TaskId,
    type TaskPriority,
    type TaskStatus,
    type TaskUpdateInput,
} from "./tasks/Task.js";
export {
    taskEventIdSchema,
    taskEventPayloadSchema,
    taskEventSchema,
    taskModuleListenerSchema,
    type TaskEvent,
    type TaskModuleListener,
    type TaskEventPayload,
} from "./tasks/TaskEvent.js";
export {
    MAX_TASK_DEPENDENCY_PAGE_SIZE,
    MAX_TASK_DETAIL_PAGE_SIZE,
    taskDetailPageSchema,
    taskDetailQuerySchema,
    type TaskDetailPage,
    type TaskDetailQuery,
} from "./tasks/TaskDetailPage.js";
export {
    taskPageQuerySchema,
    taskPageSchema,
    type TaskPage,
    type TaskPageQuery,
} from "./tasks/TaskPage.js";
export { createTaskTool } from "./tasks/tools/create_task.js";
export { getTaskTool } from "./tasks/tools/get_task.js";
export { listTasksTool } from "./tasks/tools/list_tasks.js";
export { updateTaskTool } from "./tasks/tools/update_task.js";
export { completeTaskTool } from "./tasks/tools/complete_task.js";

// Collaboration: durable agent rosters, directed messages, reply obligations, waits, and schedules.
export * from "./collaboration/index.js";

// Workflows: host-managed durable workflow runs, scoped to the calling agent.
export * from "./workflows/index.js";

// Usage: advisory provider, model, token, and timing accounting.
export * from "./usage/index.js";

// Applets: versioned UI sources installed on disk, and their bounded assets.
export {
    MAX_APPLET_ASSET_BYTES,
    MAX_APPLET_ASSET_OUTPUT_CHARACTERS,
    MAX_APPLET_LIST_SIZE,
    MAX_APPLET_SOURCE_BYTES,
    MAX_APPLET_SOURCE_FILE_BYTES,
    MAX_APPLET_SOURCE_FILES,
    MAX_APPLET_VERSIONS,
    appletActionRefSchema,
    appletAssetEncodingSchema,
    appletAssetPathSchema,
    appletAssetReadInputSchema,
    appletAssetResultSchema,
    appletAssetSchema,
    appletChangeDescriptionSchema,
    appletCreateInputSchema,
    appletCurrentResultSchema,
    appletDescriptionSchema,
    appletFingerprintSchema,
    appletImportInputSchema,
    appletListPageSchema,
    appletListQuerySchema,
    appletListSchema,
    appletNameSchema,
    appletOperationReceiptSchema,
    appletPurposeSchema,
    appletRefSchema,
    appletRevertInputSchema,
    appletSchema,
    appletScopeRefSchema,
    appletSourcePathSchema,
    appletTimestampSchema,
    appletToolImportInputSchema,
    appletToolRevertInputSchema,
    appletToolUpdateInputSchema,
    appletUpdateInputSchema,
    appletVersionNumberSchema,
    appletVersionSchema,
    type Applet,
    type AppletActionRef,
    type AppletAsset,
    type AppletAssetEncoding,
    type AppletAssetPath,
    type AppletAssetReadInput,
    type AppletChangeDescription,
    type AppletCreateInput,
    type AppletCurrentResult,
    type AppletDescription,
    type AppletFingerprint,
    type AppletImportInput,
    type AppletListPage,
    type AppletListQuery,
    type AppletName,
    type AppletOperationReceipt,
    type AppletPurpose,
    type AppletRef,
    type AppletRevertInput,
    type AppletScopeRef,
    type AppletSourcePath,
    type AppletTimestamp,
    type AppletToolImportInput,
    type AppletToolRevertInput,
    type AppletToolUpdateInput,
    type AppletUpdateInput,
    type AppletVersion,
    type AppletVersionNumber,
} from "./applets/Applet.js";
export {
    appletEventIdSchema,
    appletEventSchema,
    appletModuleListenerSchema,
    type AppletEvent,
    type AppletModuleListener,
} from "./applets/AppletEvent.js";
export {
    appletCatalogCreateInputSchema,
    appletCatalogCreateResultSchema,
    appletCatalogMutationProofSchema,
    appletCatalogMutationReceiptSchema,
    appletCatalogMutationResultSchema,
    appletCatalogOperationSchema,
    appletCatalogRemoveResultSchema,
    appletCatalogRevertInputSchema,
    appletCatalogRevertResultSchema,
    appletCatalogSchema,
    appletCatalogUpdateInputSchema,
    appletCatalogUpdateResultSchema,
    assertApplet,
    assertAppletAsset,
    assertAppletCurrent,
    assertAppletMutation,
    assertAppletMutationProof,
    assertAppletMutationReceipt,
    assertAppletPage,
    type AppletCatalog,
    type AppletCatalogCreateInput,
    type AppletCatalogCreateResult,
    type AppletCatalogMutationProof,
    type AppletCatalogMutationReceipt,
    type AppletCatalogMutationResult,
    type AppletCatalogOperation,
    type AppletCatalogRemoveResult,
    type AppletCatalogRevertInput,
    type AppletCatalogRevertResult,
    type AppletCatalogSchema,
    type AppletCatalogUpdateInput,
    type AppletCatalogUpdateResult,
} from "./applets/AppletStore.js";
export { appletIconUrl, defaultAppletsRootDirectory } from "./applets/appletPaths.js";
export { MAX_APPLET_ICON_BYTES } from "./applets/appletIcon.js";
export {
    AppletModule,
    appletModuleOptionsSchema,
    assertAppletModuleOptions,
    type AppletModuleOptions,
} from "./applets/AppletModule.js";
export { createAppletTool } from "./applets/tools/create_applet.js";
export { getAppletTool } from "./applets/tools/get_applet.js";
export { importAppletTool } from "./applets/tools/import_applet.js";
export { listAppletsTool } from "./applets/tools/list_applets.js";
export { readAppletAssetTool } from "./applets/tools/read_applet_asset.js";
export { removeAppletTool } from "./applets/tools/remove_applet.js";
export { revertAppletTool } from "./applets/tools/revert_applet.js";
export { updateAppletTool } from "./applets/tools/update_applet.js";

// Image generation: a host-supplied generator returns bytes, which the module writes to disk.
export * from "./imageGeneration/index.js";

// Secrets: safe metadata/reference operations backed by a host-owned registry.
export {
    secretAgentIdSchema,
    secretAttachReferenceResultSchema,
    secretAttachmentSchema,
    secretAttachInputSchema,
    secretCursorSchema,
    secretDetachInputSchema,
    secretDescriptionSchema,
    secretEnvironmentVariableNameSchema,
    secretEnvironmentVariableValueSchema,
    secretHostEnvironmentSchema,
    secretIdSchema,
    secretListInputSchema,
    secretListQuerySchema,
    secretMutationOperationSchema,
    secretPageSchema,
    secretReferenceSchema,
    secretRegistrationInputSchema,
    secretRegistrationSchema,
    secretRevisionSchema,
    secretScopeRefSchema,
    secretUpdateInputSchema,
    type SecretAgentId,
    type SecretAttachReferenceResult,
    type SecretAttachment,
    type SecretAttachInput,
    type SecretCursor,
    type SecretDetachInput,
    type SecretEnvironmentVariableName,
    type SecretEnvironmentVariableValue,
    type SecretHostEnvironment,
    type SecretId,
    type SecretListInput,
    type SecretListQuery,
    type SecretMutationOperation,
    type SecretPage,
    type SecretReference,
    type SecretRegistration,
    type SecretRegistrationInput,
    type SecretRevision,
    type SecretScopeRef,
    type SecretUpdateInput,
} from "./secrets/Secret.js";
export {
    secretEventIdSchema,
    secretEventSchema,
    secretEventTimestampSchema,
    secretContextSchema,
    secretModuleListenerSchema,
    type SecretEvent,
    type SecretModuleListener,
} from "./secrets/SecretEvent.js";
export {
    assertSecretAttachment,
    assertSecretAuthorization,
    assertSecretHostEnvironment,
    assertSecretPage,
    assertSecretReference,
    assertSecretResolver,
    assertSecretStore,
    assertSecretStoreMutationResult,
    secretAuthorizationOperationSchema,
    secretAuthorizationSchema,
    secretResolverSchema,
    secretStoreAttachResultSchema,
    secretStoreDetachResultSchema,
    secretStoreMutationResultSchema,
    secretStoreRegisterResultSchema,
    secretStoreRemoveResultSchema,
    secretStoreSchema,
    secretStoreUpdateResultSchema,
    type SecretAuthorization,
    type SecretResolver,
    type SecretStore,
    type SecretStoreAttachResult,
    type SecretStoreDetachResult,
    type SecretStoreMutationResult,
    type SecretStoreRegisterResult,
    type SecretStoreRemoveResult,
    type SecretStoreUpdateResult,
} from "./secrets/SecretStore.js";
export {
    SecretsModule,
    secretModuleOptionsSchema,
    assertSecretsModuleOptions,
    type SecretsModuleOptions,
} from "./secrets/SecretsModule.js";
export { attachSecretTool } from "./secrets/tools/attach_secret.js";
export { detachSecretTool } from "./secrets/tools/detach_secret.js";
export { listSecretsTool } from "./secrets/tools/list_secrets.js";
export { referenceSecretTool } from "./secrets/tools/reference_secret.js";

// Search: provider-neutral web search and fetch over a host-supplied backend.
export {
    MAX_FETCH_CONTENT_CHARACTERS,
    MAX_FETCH_CONTENT_TYPE_LENGTH,
    MAX_FETCH_TITLE_LENGTH,
    MAX_FETCH_URL_LENGTH,
    MAX_SEARCH_AGENT_ID_LENGTH,
    MAX_SEARCH_CURSOR,
    MAX_SEARCH_QUERY_LENGTH,
    MAX_SEARCH_RESULT_ID_LENGTH,
    MAX_SEARCH_RESULT_PUBLISHED_AT_LENGTH,
    MAX_SEARCH_RESULT_SNIPPET_LENGTH,
    MAX_SEARCH_RESULT_SOURCE_LENGTH,
    MAX_SEARCH_RESULT_TITLE_LENGTH,
    MAX_SEARCH_RESULT_URL_LENGTH,
    MAX_SEARCH_RESULTS_PER_PAGE,
    fetchInputSchema,
    fetchResultSchema,
    searchAgentIdSchema,
    searchCursorSchema,
    searchQuerySchema,
    searchPageSchema,
    searchResultSchema,
    type FetchInput,
    type FetchResult,
    type SearchPage,
    type SearchQuery,
    type SearchResult,
} from "./search/Search.js";
export {
    searchBackendSchema,
    searchContextSchema,
    type SearchBackend,
} from "./search/SearchBackend.js";
export {
    SearchModule,
    searchModuleOptionsSchema,
    type SearchModuleOptions,
} from "./search/SearchModule.js";
export { webFetchTool } from "./search/tools/web_fetch.js";
export { webSearchTool } from "./search/tools/web_search.js";

// Slots: host-owned UI slot entries and opaque applet actions.
export {
    allowedSlotScopes,
    slotActionSchema,
    slotAgentIdSchema,
    slotAppletIdSchema,
    slotAppletPathSchema,
    slotButtonLabelSchema,
    slotContentSchema,
    slotCreateInputSchema,
    slotDescriptionSchema,
    slotEntrySchema,
    slotIdSchema,
    slotMarkdownSchema,
    slotMessageSchema,
    slotNameSchema,
    slotMutationOperationSchema,
    slotMutationOptionsSchema,
    slotOperationFingerprintSchema,
    slotOperationIdSchema,
    slotOperationStateSchema,
    slotOrderingSchema,
    slotPurposeSchema,
    slotQueryKeySchema,
    slotQueryValueSchema,
    slotReorderInputSchema,
    slotScopeReferenceIdSchema,
    slotScopeReferenceSchema,
    slotScopeSchema,
    slotTimestampSchema,
    slotUpdateInputSchema,
    MAX_SLOT_ID_LENGTH,
    MAX_SLOT_ENTRIES,
    MAX_SLOT_OUTPUT_CHARACTERS,
    MAX_SLOT_PAGE_SIZE,
    type SlotAction,
    type SlotAgentId,
    type SlotContent,
    type SlotCreateInput,
    type SlotEntry,
    type SlotId,
    type SlotName,
    type SlotMutationOperation,
    type SlotMutationOptions,
    type SlotOperationFingerprint,
    type SlotOperationId,
    type SlotOperationState,
    type SlotOrdering,
    type SlotReorderInput,
    type SlotScope,
    type SlotScopeReference,
    type SlotScopeReferenceId,
    type SlotTimestamp,
    type SlotUpdateInput,
} from "./slots/Slot.js";
export {
    slotEventIdSchema,
    slotEventSchema,
    slotModuleListenerSchema,
    type SlotEvent,
    type SlotModuleListener,
} from "./slots/SlotEvent.js";
export {
    slotCursorSchema,
    slotListSchema,
    slotPageQueryEverywhereSchema,
    slotPageQueryNoScopeSchema,
    slotPageQueryProjectSchema,
    slotPageQuerySchema,
    slotPageQuerySessionSchema,
    slotPageSchema,
    slotPageQueryWorkspaceSchema,
    type SlotCursor,
    type SlotList,
    type SlotPageQueryEverywhere,
    type SlotPageQueryNoScope,
    type SlotPageQueryProject,
    type SlotPage,
    type SlotPageQuery,
    type SlotPageQuerySession,
    type SlotPageQueryWorkspace,
} from "./slots/SlotPage.js";
export {
    MAX_SLOT_DETAIL_CHARACTERS,
    MAX_SLOT_DETAIL_PAGE_SIZE,
    slotDetailCursorSchema,
    slotDetailPageSchema,
    slotDetailQuerySchema,
    type SlotDetailCursor,
    type SlotDetailPage,
    type SlotDetailQuery,
} from "./slots/SlotDetailPage.js";
export {
    assertSlotMutationRequest,
    assertSlotMutationProof,
    assertSlotOperationReceipt,
    assertSlotStore,
    assertSlotStoreEntry,
    assertSlotStoreList,
    assertSlotStoreMutationResult,
    assertSlotStorePage,
    slotMutationRequestSchema,
    slotMutationProofSchema,
    slotOperationReceiptSchema,
    slotRemoveProofSchema,
    slotPublisherSchema,
    slotReadAuthorizationSchema,
    slotReadOperationSchema,
    slotScopeResolverSchema,
    slotStoreCreateInputContractSchema,
    slotStoreCreateResultSchema,
    slotStoreMutationResultSchema,
    slotStoreReorderResultSchema,
    slotStoreRemoveResultSchema,
    slotStoreSchema,
    slotStoreUpdateResultSchema,
    type SlotMutationRequest,
    type SlotMutationProof,
    type SlotOperationReceipt,
    type SlotRemoveProof,
    type SlotPublisher,
    type SlotReadAuthorization,
    type SlotReadOperation,
    type SlotScopeResolver,
    type SlotStore,
    type SlotStoreCreateInput,
    type SlotStoreCreateResult,
    type SlotStoreMutationResult,
    type SlotStoreReorderResult,
    type SlotStoreRemoveResult,
    type SlotStoreUpdateResult,
} from "./slots/SlotStore.js";
export {
    SlotsModule,
    slotModuleOptionsSchema,
    assertSlotsModuleOptions,
    type SlotsModuleOptions,
} from "./slots/SlotsModule.js";
export { createSlotTool } from "./slots/tools/create_slot.js";
export { getSlotTool } from "./slots/tools/get_slot.js";
export { listSlotsTool } from "./slots/tools/list_slots.js";
export { removeSlotTool } from "./slots/tools/remove_slot.js";
export { reorderSlotsTool } from "./slots/tools/reorder_slots.js";
export { updateSlotTool } from "./slots/tools/update_slot.js";

// Workspaces: host-owned worktree/Git references, bounded catalogs, and
// cursor-addressable detail.
export * from "./workspaces/index.js";

// Worklets: versioned code installed on disk, with its data surviving updates and reverts.
export * from "./worklets/index.js";

// Scheduling: messages the agent asks to be delivered later, and waits it can take.
export * from "./scheduling/index.js";

// Projects: the durable places work happens, with their own settings.
export * from "./projects/index.js";

// User input: questions the agent asks a person, and the answers it waits for.
export * from "./userInput/index.js";

// Integration modules: Happy clients, MCP servers, skills, and AGENTS.md instructions.
export * from "./happy/index.js";
export * from "./mcp/index.js";
export * from "./skills/index.js";
export * from "./agentsMd/index.js";

export {
    assertHistoryReader,
    historyReaderSchema,
    type HistoryReader,
} from "./history/HistoryReader.js";
