import { desc, sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const projectAvatarAssets = sqliteTable("project_avatar_assets", {
    hash: text("hash").primaryKey(),
    mediaType: text("media_type").notNull(),
    byteLength: integer("byte_length").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    dereferencedAtMs: integer("dereferenced_at_ms"),
});

export const projects = sqliteTable(
    "projects",
    {
        id: text("id").primaryKey(),
        path: text("path").notNull().unique(),
        storageKey: text("storage_key").notNull().unique(),
        kind: text("kind").notNull(),
        name: text("name").notNull(),
        nameKey: text("name_key").notNull().unique(),
        nameSource: text("name_source").notNull(),
        orderKey: text("order_key").notNull(),
        avatarHash: text("avatar_hash").references(() => projectAvatarAssets.hash),
        avatarSource: text("avatar_source"),
        initializationStatus: text("initialization_status").notNull(),
        initializationError: text("initialization_error"),
        initializationAttempt: integer("initialization_attempt").notNull(),
        presence: text("presence").notNull(),
        worktreeSupport: text("worktree_support").notNull(),
        worktreeSupportReason: text("worktree_support_reason"),
        gitBranch: text("git_branch"),
        gitHead: text("git_head"),
        gitUpstream: text("git_upstream"),
        gitAhead: integer("git_ahead").notNull(),
        gitBehind: integer("git_behind").notNull(),
        gitDetached: integer("git_detached", { mode: "boolean" }).notNull(),
        version: integer("version").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
        archivedAtMs: integer("archived_at_ms"),
        defaultBranch: text("default_branch"),
    },
    (table) => [
        index("projects_updated").on(desc(table.updatedAtMs)),
        index("projects_order").on(table.orderKey),
    ],
);

export const projectWorkspaces = sqliteTable(
    "project_workspaces",
    {
        id: text("id").primaryKey(),
        projectId: text("project_id")
            .notNull()
            .references(() => projects.id),
        path: text("path").notNull().unique(),
        storageKey: text("storage_key").notNull(),
        name: text("name").notNull(),
        nameKey: text("name_key").notNull(),
        title: text("title"),
        orderKey: text("order_key").notNull(),
        kind: text("kind").notNull(),
        status: text("status").notNull(),
        baseRef: text("base_ref"),
        baseCommit: text("base_commit"),
        gitCommonDir: text("git_common_dir").notNull(),
        error: text("error"),
        creatorSessionId: text("creator_session_id"),
        presence: text("presence").notNull(),
        gitBranch: text("git_branch"),
        gitHead: text("git_head"),
        gitUpstream: text("git_upstream"),
        gitAhead: integer("git_ahead").notNull(),
        gitBehind: integer("git_behind").notNull(),
        gitDetached: integer("git_detached", { mode: "boolean" }).notNull(),
        version: integer("version").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
        archivedAtMs: integer("archived_at_ms"),
    },
    (table) => [
        unique().on(table.projectId, table.storageKey),
        unique().on(table.projectId, table.nameKey),
        index("project_workspaces_project_updated").on(table.projectId, desc(table.updatedAtMs)),
        index("project_workspaces_project_order").on(table.projectId, table.orderKey),
    ],
);

export const sessions = sqliteTable(
    "sessions",
    {
        id: text("id").primaryKey(),
        agentId: text("agent_id").notNull(),
        projectId: text("project_id")
            .notNull()
            .references(() => projects.id),
        workspaceId: text("workspace_id").references(() => projectWorkspaces.id),
        orderKey: text("order_key").notNull(),
        sessionKind: text("session_kind").notNull(),
        parentSessionId: text("parent_session_id"),
        rootSessionId: text("root_session_id").notNull(),
        depth: integer("depth").notNull(),
        parentToolCallId: text("parent_tool_call_id"),
        taskName: text("task_name"),
        description: text("description"),
        archived: integer("archived", { mode: "boolean" }).notNull(),
        trackUnread: integer("track_unread", { mode: "boolean" }).notNull(),
        unreadReason: text("unread_reason"),
        unreadSinceMs: integer("unread_since_ms"),
        cwd: text("cwd").notNull(),
        draft: text("draft"),
        draftUpdatedAtMs: integer("draft_updated_at_ms"),
        dockerJson: text("docker_json"),
        secretIdsJson: text("secret_ids_json").notNull(),
        providerId: text("provider_id").notNull(),
        modelId: text("model_id").notNull(),
        effort: text("effort"),
        serviceTier: text("service_tier"),
        instructions: text("instructions"),
        appendSystemPrompt: text("append_system_prompt"),
        systemPrompt: text("system_prompt"),
        externalToolsJson: text("external_tools_json").notNull(),
        durableSkillsJson: text("durable_skills_json").notNull(),
        status: text("status").notNull(),
        activeRunId: text("active_run_id"),
        activeSinceMs: integer("active_since_ms"),
        elapsedMs: integer("elapsed_ms").notNull(),
        totalTokens: integer("total_tokens").notNull(),
        sessionTokenCountJson: text("session_token_count_json"),
        usageJson: text("usage_json"),
        lastEventId: text("last_event_id"),
        permissionMode: text("permission_mode").notNull(),
        modelsJson: text("models_json").notNull(),
        toolsJson: text("tools_json").notNull(),
        tasksJson: text("tasks_json").notNull(),
        workflowsJson: text("workflows_json").notNull(),
        workflowsEnabled: integer("workflows_enabled", { mode: "boolean" }).notNull(),
        goalJson: text("goal_json"),
        nextTaskId: integer("next_task_id").notNull(),
        title: text("title"),
        titleStatus: text("title_status").notNull(),
        titleError: text("title_error"),
        recap: text("recap"),
        metadataUpdatedAtMs: integer("metadata_updated_at_ms"),
        metadataRunId: text("metadata_run_id"),
        interrupted: integer("interrupted", { mode: "boolean" }).notNull(),
        interruptionJson: text("interruption_json"),
        lastMessageAtMs: integer("last_message_at_ms"),
        createdAtMs: integer("created_at_ms").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
        // Added by later migrations, so they follow the columns of the initial schema.
        delegatedBySessionId: text("delegated_by_session_id"),
        lifetimeTotalTokens: integer("lifetime_total_tokens").notNull().default(0),
    },
    (table) => [
        index("sessions_agent_id").on(table.agentId),
        index("sessions_parent_created").on(table.parentSessionId, table.createdAtMs),
        index("sessions_delegated_created").on(
            table.delegatedBySessionId,
            table.createdAtMs,
            table.id,
        ),
        index("sessions_project_activity").on(
            table.projectId,
            sql`${table.lastMessageAtMs} DESC`,
            sql`${table.updatedAtMs} DESC`,
        ),
        index("sessions_workspace_activity").on(
            table.workspaceId,
            sql`${table.lastMessageAtMs} DESC`,
            sql`${table.updatedAtMs} DESC`,
        ),
        index("sessions_parent_order").on(table.projectId, table.workspaceId, table.orderKey),
    ],
);

export const sessionEvents = sqliteTable(
    "session_events",
    {
        seq: integer("seq").primaryKey({ autoIncrement: true }),
        sessionId: text("session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        eventId: text("event_id").notNull().unique(),
        type: text("type").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
        dataJson: text("data_json").notNull(),
        runId: text("run_id"),
        messageId: text("message_id"),
        toolCallId: text("tool_call_id"),
    },
    (table) => [
        index("session_events_session_seq").on(table.sessionId, table.seq),
        index("session_events_session_type_seq").on(table.sessionId, table.type, table.seq),
        index("session_events_run_id").on(table.sessionId, table.runId, table.seq),
        index("session_events_message_id").on(table.sessionId, table.messageId, table.seq),
        index("session_events_tool_call_id").on(table.sessionId, table.toolCallId, table.seq),
    ],
);

export const sessionMessages = sqliteTable(
    "session_messages",
    {
        sessionId: text("session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        position: integer("position").notNull(),
        messageId: text("message_id").notNull(),
        role: text("role").notNull(),
        isPartial: integer("is_partial", { mode: "boolean" }).notNull(),
        runId: text("run_id"),
        messageJson: text("message_json").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.sessionId, table.position] }),
        index("session_messages_session_message").on(table.sessionId, table.messageId),
    ],
);

export const sessionContextMessages = sqliteTable(
    "session_context_messages",
    {
        sessionId: text("session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        position: integer("position").notNull(),
        messageId: text("message_id").notNull(),
        role: text("role").notNull(),
        messageJson: text("message_json").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.sessionId, table.position] }),
        index("session_context_messages_session_message").on(table.sessionId, table.messageId),
    ],
);

export const sessionTurns = sqliteTable(
    "session_turns",
    {
        sessionId: text("session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        runId: text("run_id").notNull(),
        firstPosition: integer("first_position").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.sessionId, table.runId] }),
        index("session_turns_order").on(table.sessionId, table.firstPosition),
    ],
);

export const queuedRuns = sqliteTable(
    "queued_runs",
    {
        sessionId: text("session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        runId: text("run_id").notNull(),
        debug: integer("debug", { mode: "boolean" }).notNull(),
        debugDirectory: text("debug_directory"),
        displayText: text("display_text").notNull(),
        kind: text("kind").notNull(),
        text: text("text").notNull(),
        userMessageJson: text("user_message_json").notNull(),
        integrationConfigJson: text("integration_config_json"),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [primaryKey({ columns: [table.sessionId, table.runId] })],
);

export const externalToolCalls = sqliteTable(
    "external_tool_calls",
    {
        id: text("id").primaryKey(),
        sessionId: text("session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        runId: text("run_id").notNull(),
        batchId: text("batch_id").notNull(),
        toolCallId: text("tool_call_id").notNull(),
        providerToolCallId: text("provider_tool_call_id"),
        toolCallIndex: integer("tool_call_index").notNull(),
        definitionJson: text("definition_json").notNull(),
        skillJson: text("skill_json"),
        argumentsJson: text("arguments_json").notNull(),
        status: text("status").notNull(),
        resolutionJson: text("resolution_json"),
        consumed: integer("consumed", { mode: "boolean" }).notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
        resolvedAtMs: integer("resolved_at_ms"),
    },
    (table) => [
        index("external_tool_calls_session_created").on(table.sessionId, table.createdAtMs),
    ],
);

export const durableUserInputs = sqliteTable(
    "durable_user_inputs",
    {
        sessionId: text("session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        requestId: text("request_id").notNull(),
        runId: text("run_id").notNull(),
        batchId: text("batch_id").notNull(),
        toolCallId: text("tool_call_id").notNull(),
        providerToolCallId: text("provider_tool_call_id"),
        toolCallIndex: integer("tool_call_index").notNull(),
        toolName: text("tool_name").notNull(),
        toolArgumentsJson: text("tool_arguments_json").notNull(),
        kind: text("kind").notNull(),
        permissionJson: text("permission_json"),
        requestJson: text("request_json").notNull(),
        responseJson: text("response_json"),
        resultJson: text("result_json"),
        status: text("status").notNull(),
        consumed: integer("consumed", { mode: "boolean" }).notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
        resolvedAtMs: integer("resolved_at_ms"),
        detachedAtMs: integer("detached_at_ms"),
        answerDueAtMs: integer("answer_due_at_ms"),
        answerWaitStartedAtMs: integer("answer_wait_started_at_ms"),
    },
    (table) => [
        primaryKey({ columns: [table.sessionId, table.requestId] }),
        index("durable_user_inputs_session_created").on(table.sessionId, table.createdAtMs),
    ],
);

export const durableWaits = sqliteTable(
    "durable_waits",
    {
        id: text("id").primaryKey(),
        sessionId: text("session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        runId: text("run_id").notNull(),
        batchId: text("batch_id").notNull(),
        toolCallId: text("tool_call_id").notNull(),
        providerToolCallId: text("provider_tool_call_id"),
        toolCallIndex: integer("tool_call_index").notNull(),
        toolName: text("tool_name").notNull(),
        kind: text("kind").notNull(),
        argumentsJson: text("arguments_json").notNull(),
        status: text("status").notNull(),
        consumed: integer("consumed", { mode: "boolean" }).notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
        dueAtMs: integer("due_at_ms").notNull(),
        resultJson: text("result_json"),
        resultBlockJson: text("result_block_json"),
    },
    (table) => [
        unique().on(table.sessionId, table.toolCallId),
        index("durable_waits_session_created").on(table.sessionId, table.createdAtMs),
    ],
);

export const scheduledMessages = sqliteTable(
    "scheduled_messages",
    {
        id: text("id").primaryKey(),
        senderSessionId: text("sender_session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        targetAgentId: text("target_agent_id").notNull(),
        message: text("message").notNull(),
        dueAtMs: integer("due_at_ms").notNull(),
        status: text("status").notNull(),
        failure: text("failure"),
        deliveredAtMs: integer("delivered_at_ms"),
        createdAtMs: integer("created_at_ms").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
    },
    (table) => [
        index("scheduled_messages_sender_created").on(table.senderSessionId, table.createdAtMs),
        index("scheduled_messages_pending_due").on(table.status, table.dueAtMs),
    ],
);

export const secretRegistrations = sqliteTable("secret_registrations", {
    id: text("id").primaryKey(),
    description: text("description").notNull(),
    environmentJson: text("environment_json").notNull(),
});

export const secretEnvironmentVariables = sqliteTable(
    "secret_environment_variables",
    {
        secretId: text("secret_id")
            .notNull()
            .references(() => secretRegistrations.id, { onDelete: "cascade" }),
        normalizedName: text("normalized_name").notNull(),
        name: text("name").notNull(),
    },
    (table) => [primaryKey({ columns: [table.secretId, table.normalizedName] })],
);

export const projectSecretAttachments = sqliteTable(
    "project_secret_attachments",
    {
        projectId: text("project_id")
            .notNull()
            .references(() => projects.id, { onDelete: "cascade" }),
        secretId: text("secret_id")
            .notNull()
            .references(() => secretRegistrations.id, { onDelete: "cascade" }),
    },
    (table) => [primaryKey({ columns: [table.projectId, table.secretId] })],
);

export const happySessions = sqliteTable("happy_sessions", {
    sessionId: text("session_id")
        .primaryKey()
        .references(() => sessions.id, { onDelete: "cascade" }),
    credentialFingerprint: text("credential_fingerprint").notNull(),
    tag: text("tag").notNull(),
    remoteSessionId: text("remote_session_id"),
    encryptionVariant: text("encryption_variant").notNull(),
    encryptionKeyBase64: text("encryption_key_base64").notNull(),
    lastRemoteSeq: integer("last_remote_seq").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
});

export const happyOutbox = sqliteTable(
    "happy_outbox",
    {
        seq: integer("seq").primaryKey({ autoIncrement: true }),
        sessionId: text("session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        localId: text("local_id").notNull(),
        payloadJson: text("payload_json").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [
        unique().on(table.sessionId, table.localId),
        index("happy_outbox_session_seq").on(table.sessionId, table.seq),
    ],
);

export const slotEntries = sqliteTable("slot_entries", {
    id: text("id").primaryKey(),
    slot: text("slot").notNull(),
    scope: text("scope").notNull(),
    projectId: text("project_id").references(() => projects.id),
    workspaceId: text("workspace_id").references(() => projectWorkspaces.id),
    sessionId: text("session_id"),
    contentJson: text("content_json").notNull(),
    authorSessionId: text("author_session_id").notNull(),
    description: text("description").notNull(),
    purpose: text("purpose").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
});

export const webapps = sqliteTable("webapps", {
    name: text("name").primaryKey(),
    description: text("description").notNull(),
    purpose: text("purpose").notNull(),
    authorSessionId: text("author_session_id").notNull(),
    sourceDescription: text("source_description"),
    currentVersion: integer("current_version").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    iconThumbhash: text("icon_thumbhash").notNull(),
});

export const webappVersions = sqliteTable(
    "webapp_versions",
    {
        webappName: text("webapp_name")
            .notNull()
            .references(() => webapps.name, { onDelete: "cascade" }),
        version: integer("version").notNull(),
        changeDescription: text("change_description").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [primaryKey({ columns: [table.webappName, table.version] })],
);

export const durableGlobalEvents = sqliteTable("durable_global_events", {
    cursor: text("cursor").primaryKey(),
    eventId: text("event_id").notNull().unique(),
    aggregateKind: text("aggregate_kind").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    type: text("type").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    dataJson: text("data_json").notNull(),
});

export const durableGlobalEventState = sqliteTable("durable_global_event_state", {
    trimmedThroughCursor: text("trimmed_through_cursor").primaryKey(),
});
