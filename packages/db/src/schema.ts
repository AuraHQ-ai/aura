import {
  pgTable,
  uuid,
  text,
  pgEnum,
  timestamp,
  real,
  integer,
  jsonb,
  boolean,
  index,
  uniqueIndex,
  serial,
  unique,
  vector,
  date,
  check,
  primaryKey,
  smallint,
  numeric,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── Enums ──────────────────────────────────────────────────────────────────

export const channelTypeEnum = pgEnum("channel_type", [
  "dm",
  "public_channel",
  "private_channel",
  "dashboard",
]);

export const messageRoleEnum = pgEnum("message_role", [
  "user",
  "assistant",
  "tool",
]);

export const memoryTypeEnum = pgEnum("memory_type", [
  "fact",
  "decision",
  "personal",
  "preference",
  "relationship",
  "sentiment",
  "event",
  "open_thread",
  "insight",
]);

// Helper for timestamptz columns
const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

// Helper for workspace_id columns
const workspaceId = () => text("workspace_id").notNull().default("default");

// ── Workspaces ────────────────────────────────────────────────────────────

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name"),
  domain: text("domain"),
  installedAt: timestamptz("installed_at").notNull().defaultNow(),
  plan: text("plan").default("free"),
  settings: jsonb("settings").$type<Record<string, unknown>>(),
});

// ── Messages ───────────────────────────────────────────────────────────────

export const messages = pgTable(
  "messages",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: workspaceId().references(() => workspaces.id),
    externalId: text("external_id").notNull(),
    slackTs: text("slack_ts"),
    slackThreadTs: text("slack_thread_ts"),
    channelId: text("channel_id").notNull(),
    channelType: channelTypeEnum("channel_type").notNull(),
    userId: text("user_id").notNull(),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    tokenUsage: jsonb("token_usage").$type<{ inputTokens: number; outputTokens: number; totalTokens: number }>(),
    model: text("model"),
    embedding: vector("embedding", { dimensions: 1536 }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("messages_workspace_external_id_idx").on(table.workspaceId, table.externalId),
    index("messages_channel_created_idx").on(table.channelId, table.createdAt),
    index("messages_thread_idx").on(table.slackThreadTs),
    index("messages_role_created_idx").on(table.role, table.createdAt),
    index("messages_embedding_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  ],
);

// ── Memories ───────────────────────────────────────────────────────────────

export const memories = pgTable(
  "memories",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: workspaceId().references(() => workspaces.id),
    content: text("content").notNull(),
    type: memoryTypeEnum("type").notNull(),
    category: text("category").notNull().default("semantic"),
    sourceMessageId: uuid("source_message_id").references(() => messages.id),
    sourceChannelType: channelTypeEnum("source_channel_type").notNull(),
    relatedUserIds: text("related_user_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    embedding: vector("embedding", { dimensions: 1536 }),
    relevanceScore: real("relevance_score").notNull().default(1.0),
    shareable: integer("shareable").notNull().default(0),
    searchVector: text("search_vector"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("memories_embedding_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    index("memories_related_users_idx").using("gin", table.relatedUserIds),
    index("memories_type_idx").on(table.type),
    index("memories_created_at_idx").on(table.createdAt),
    index("memories_search_vector_idx").using(
      "gin",
      sql`${table.searchVector}`,
    ),
  ],
);

// ── Entities ───────────────────────────────────────────────────────────────

export const entities = pgTable(
  "entities",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: workspaceId().references(() => workspaces.id),
    type: text("type").notNull(),
    canonicalName: text("canonical_name").notNull(),
    description: text("description"),
    slackUserId: text("slack_user_id"),
    summary: text("summary"),
    summaryUpdatedAt: timestamptz("summary_updated_at"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("entities_type_canonical_idx").on(table.workspaceId, table.type, sql`lower(${table.canonicalName})`),
    uniqueIndex("entities_slack_user_idx")
      .on(table.workspaceId, table.slackUserId)
      .where(sql`slack_user_id IS NOT NULL`),
  ],
);

// ── Entity Aliases ─────────────────────────────────────────────────────────

export const entityAliases = pgTable(
  "entity_aliases",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    aliasLower: text("alias_lower"),
    source: text("source").default("extracted"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("entity_aliases_lower_entity_idx").on(table.aliasLower, table.entityId),
    index("entity_aliases_trgm_idx").using("gin", sql`${table.aliasLower} gin_trgm_ops`),
  ],
);

// ── Memory Entities (junction table) ───────────────────────────────────────

export const memoryEntities = pgTable(
  "memory_entities",
  {
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    role: text("role").default("mentioned"),
  },
  (table) => [
    primaryKey({ columns: [table.memoryId, table.entityId] }),
    index("memory_entities_entity_idx").on(table.entityId),
  ],
);

// ── Users (formerly user_profiles, merged with people) ─────────────────────

export interface CommunicationStyle {
  verbosity: "terse" | "moderate" | "verbose";
  formality: "casual" | "neutral" | "formal";
  emojiUsage: "none" | "light" | "heavy";
  preferredFormat: "prose" | "bullets" | "mixed";
}

export interface KnownFacts {
  role?: string;
  team?: string;
  interests?: string[];
  personalDetails?: string[];
  preferences?: string[];
}

export const users = pgTable(
  "users",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: workspaceId().references(() => workspaces.id),
    slackUserId: text("slack_user_id"),
    displayName: text("display_name").notNull(),
    timezone: text("timezone"),
    personId: uuid("person_id"),
    jobTitle: text("job_title"),
    gender: text("gender"),
    preferredLanguage: text("preferred_language").default("en"),
    birthdate: date("birthdate", { mode: "date" }),
    managerId: text("manager_id"),
    notes: text("notes"),
    entityId: uuid("entity_id").references(() => entities.id),
    communicationStyle: jsonb("communication_style")
      .$type<CommunicationStyle>()
      .default({
        verbosity: "moderate",
        formality: "neutral",
        emojiUsage: "light",
        preferredFormat: "mixed",
      }),
    knownFacts: jsonb("known_facts").$type<KnownFacts>().default({}),
    role: text("role").notNull().default("member"),
    interactionCount: integer("interaction_count").notNull().default(0),
    lastInteractionAt: timestamptz("last_interaction_at"),
    lastProfileConsolidation: timestamptz("last_profile_consolidation"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("user_profiles_workspace_slack_user_id_idx").on(table.workspaceId, table.slackUserId),
  ],
);


// ── Addresses ──────────────────────────────────────────────────────────────

export const addresses = pgTable(
  "addresses",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: workspaceId().references(() => workspaces.id),
    personId: uuid("person_id"),
    userId: uuid("user_id").references(() => users.id),
    channel: text("channel").notNull(),
    value: text("value").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("addresses_workspace_channel_value_idx").on(table.workspaceId, table.channel, table.value),
    index("addresses_person_id_idx").on(table.personId),
    index("addresses_user_id_idx").on(table.userId),
  ],
);

// ── Channels ───────────────────────────────────────────────────────────────

export const channels = pgTable(
  "channels",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: workspaceId().references(() => workspaces.id),
    slackChannelId: text("slack_channel_id").notNull(),
    name: text("name").notNull(),
    type: channelTypeEnum("type").notNull(),
    topic: text("topic"),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("channels_workspace_slack_channel_id_idx").on(table.workspaceId, table.slackChannelId),
  ],
);

// ── Settings ────────────────────────────────────────────────────────────────

export const settings = pgTable(
  "settings",
  {
    workspaceId: workspaceId().references(() => workspaces.id),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    updatedBy: text("updated_by"),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.key] }),
  ],
);

// ── Notes (agent scratchpad with three-tier hierarchy) ──────────────────────

export const notes = pgTable(
  "notes",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: workspaceId().references(() => workspaces.id),
    topic: text("topic").notNull(),
    content: text("content").notNull(),
    category: text("category").notNull().default("knowledge"),
    summary: text("summary"),
    injectInContext: boolean("inject_in_context").notNull().default(false),
    importance: smallint("importance").notNull().default(50),
    ownerId: text("owner_id"),
    visibility: text("visibility").notNull().default("shared"),
    embedding: vector("embedding", { dimensions: 1536 }),
    expiresAt: timestamptz("expires_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("notes_workspace_topic_idx").on(table.workspaceId, table.topic),
    index("notes_category_idx").on(table.category),
    index("notes_embedding_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  ],
);

// ── Resources (raw ingested source material) ─────────────────────────────────

export const resources = pgTable(
  "resources",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    url: text("url").notNull(),
    parentUrl: text("parent_url"),
    title: text("title"),
    source: text("source").notNull(),
    status: text("status")
      .$type<"pending" | "ready" | "error">()
      .notNull()
      .default("pending"),
    content: text("content"),
    summary: text("summary"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    embedding: vector("embedding", { dimensions: 1536 }),
    contentHash: text("content_hash"),
    errorMessage: text("error_message"),
    crawledAt: timestamptz("crawled_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("resources_url_idx").on(table.url),
    index("resources_embedding_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    index("resources_content_fts_idx").using(
      "gin",
      sql`to_tsvector('english', coalesce(${table.content}, ''))`,
    ),
    index("resources_source_idx").on(table.source),
    index("resources_parent_url_idx")
      .on(table.parentUrl)
      .where(sql`parent_url IS NOT NULL`),
    index("resources_crawled_at_idx").on(table.crawledAt),
  ],
);

// ── Jobs (unified: one-shot tasks, recurring work, continuations) ───────────

export interface FrequencyConfig {
  minIntervalHours?: number;
  maxPerDay?: number;
  cooldownHours?: number;
}

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: workspaceId().references(() => workspaces.id),
    name: text("name").notNull(),
    description: text("description").notNull(),
    playbook: text("playbook"),
    script: text("script"),
    cronSchedule: text("cron_schedule"),
    frequencyConfig: jsonb("frequency_config").$type<FrequencyConfig>(),
    channelId: text("channel_id"),
    threadTs: text("thread_ts"),
    executeAt: timestamptz("execute_at"),
    requestedBy: text("requested_by").notNull().default("aura"),
    priority: text("priority").notNull().default("normal"),
    status: text("status").notNull().default("pending"),
    timezone: text("timezone").notNull().default("UTC"),
    result: text("result"),
    retries: integer("retries").notNull().default(0),
    lastExecutedAt: timestamptz("last_executed_at"),
    lastResult: text("last_result"),
    executionCount: integer("execution_count").notNull().default(0),
    todayExecutions: integer("today_executions").notNull().default(0),
    lastExecutionDate: text("last_execution_date"),
    enabled: integer("enabled").notNull().default(1),
    requiredCredentialIds: jsonb("required_credential_ids").$type<string[]>().default([]),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("jobs_workspace_name_idx").on(table.workspaceId, table.name),
    index("jobs_enabled_idx").on(table.enabled),
    index("jobs_status_execute_idx").on(table.status, table.executeAt),
  ],
);

// ── Job Executions (trace storage for every job run) ────────────────────────

export const jobExecutions = pgTable(
  "job_executions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: workspaceId().references(() => workspaces.id),
    jobId: uuid("job_id").references(() => jobs.id),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    finishedAt: timestamptz("finished_at"),
    status: text("status").notNull().default("running"),
    trigger: text("trigger").notNull().default("heartbeat"),
    callbackChannel: text("callback_channel"),
    callbackThreadTs: text("callback_thread_ts"),
    steps: jsonb("steps"),
    summary: text("summary"),
    tokenUsage: jsonb("token_usage"),
    error: text("error"),
  },
  (table) => [
    index("job_executions_job_id_idx").on(table.jobId),
    index("job_executions_started_at_idx").on(table.startedAt),
  ],
);

// ── Token usage types ────────────────────────────────────────────────────────

export interface DetailedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  outputTokenDetails?: {
    textTokens?: number;
    reasoningTokens?: number;
  };
}

// ── Model Pricing ───────────────────────────────────────────────────────────

export const modelPricing = pgTable(
  "model_pricing",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: workspaceId().references(() => workspaces.id),
    modelId: text("model_id").notNull(),
    tokenType: text("token_type").notNull(),
    pricePerMillion: numeric("price_per_million").notNull(),
    effectiveFrom: date("effective_from", { mode: "date" }).notNull(),
    effectiveUntil: date("effective_until", { mode: "date" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("model_pricing_workspace_model_token_date_unique").on(
      table.workspaceId,
      table.modelId,
      table.tokenType,
      table.effectiveFrom,
    ),
    index("model_pricing_model_id_idx").on(table.modelId),
    check(
      "model_pricing_token_type_check",
      sql`${table.tokenType} IN ('input', 'cache_read', 'cache_write', 'output', 'reasoning')`,
    ),
  ],
);

// ── Conversation Traces + Messages + Parts (unified conversation persistence) ─

export const conversationTraces = pgTable(
  "conversation_traces",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: workspaceId().references(() => workspaces.id),
    sourceType: text("source_type").notNull(),
    source: text("source").notNull().default("slack"),
    jobExecutionId: uuid("job_execution_id").references(() => jobExecutions.id),
    channelId: text("channel_id"),
    threadTs: text("thread_ts"),
    userId: text("user_id"),
    modelId: text("model_id"),
    tokenUsage: jsonb("token_usage").$type<DetailedTokenUsage>(),
    costUsd: numeric("cost_usd"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_ct_job_execution").on(table.jobExecutionId),
    index("idx_ct_channel_thread").on(table.channelId, table.threadTs),
    index("idx_ct_created_at").on(table.createdAt),
    check(
      "ct_source_type_check",
      sql`${table.sourceType} IN ('job_execution', 'interactive')`,
    ),
  ],
);

export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: workspaceId().references(() => workspaces.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversationTraces.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content"),
    orderIndex: integer("order_index").notNull(),
    modelId: text("model_id"),
    tokenUsage: jsonb("token_usage").$type<DetailedTokenUsage>(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_cm_conversation").on(table.conversationId, table.orderIndex),
    check(
      "cm_role_check",
      sql`${table.role} IN ('system', 'user', 'assistant')`,
    ),
  ],
);

export const conversationParts = pgTable(
  "conversation_parts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: workspaceId().references(() => workspaces.id),
    messageId: uuid("message_id")
      .notNull()
      .references(() => conversationMessages.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    orderIndex: integer("order_index").notNull(),
    textValue: text("text_value"),
    toolCallId: text("tool_call_id"),
    toolName: text("tool_name"),
    toolInput: jsonb("tool_input"),
    toolOutput: jsonb("tool_output"),
    toolState: text("tool_state"),
  },
  (table) => [
    index("idx_cp_message").on(table.messageId, table.orderIndex),
    check(
      "cp_type_check",
      sql`${table.type} IN ('text', 'reasoning', 'tool-invocation', 'source', 'file', 'step-start', 'error')`,
    ),
  ],
);

// ── Event Locks (dedup for Slack duplicate events) ──────────────────────────

export const eventLocks = pgTable(
  "event_locks",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: workspaceId().references(() => workspaces.id),
    eventTs: text("event_ts").notNull(),
    channelId: text("channel_id").notNull(),
    claimedAt: timestamptz("claimed_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("event_locks_workspace_event_ts_channel_id_idx").on(
      table.workspaceId,
      table.eventTs,
      table.channelId,
    ),
  ],
);

// ── Conversation Locks (invocation dedup for interruption handling) ──────────

export const conversationLocks = pgTable(
  "conversation_locks",
  {
    workspaceId: workspaceId().references(() => workspaces.id),
    channelId: text("channel_id").notNull(),
    threadTs: text("thread_ts").notNull(),
    invocationId: text("invocation_id").notNull(),
    messageTs: text("message_ts").notNull(),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.channelId, table.threadTs] }),
  ],
);

// ── Error Events ────────────────────────────────────────────────────────────

export const errorEvents = pgTable(
  "error_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: workspaceId().references(() => workspaces.id),
    timestamp: timestamptz("timestamp").notNull().defaultNow(),
    errorName: text("error_name").notNull(),
    errorMessage: text("error_message").notNull(),
    errorCode: text("error_code"),
    userId: text("user_id"),
    channelId: text("channel_id"),
    channelType: text("channel_type"),
    context: jsonb("context").$type<Record<string, unknown>>(),
    stackTrace: text("stack_trace"),
    resolved: boolean("resolved").default(false),
  },
  (table) => [
    index("error_events_timestamp_idx").on(table.timestamp),
    index("error_events_error_code_idx").on(table.errorCode),
  ],
);


// ── Emails Raw (email staging pipeline) ────────────────────────────────────

export const emailsRaw = pgTable(
  "emails_raw",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: workspaceId().references(() => workspaces.id),
    userId: text("user_id").notNull(),
    gmailMessageId: text("gmail_message_id").notNull(),
    gmailThreadId: text("gmail_thread_id").notNull(),
    subject: text("subject"),
    fromEmail: text("from_email").notNull(),
    fromName: text("from_name"),
    toEmails: jsonb("to_emails").$type<string[]>(),
    ccEmails: jsonb("cc_emails").$type<string[]>(),
    date: timestamptz("date").notNull(),
    bodyMarkdown: text("body_markdown"),
    bodySizeBytes: integer("body_size_bytes"),
    triage: text("triage"),
    triageReason: text("triage_reason"),
    threadState: text("thread_state"),
    threadStateReason: text("thread_state_reason"),
    threadStateUpdatedAt: timestamptz("thread_state_updated_at"),
    direction: text("direction").notNull(),
    hasAttachments: boolean("has_attachments").default(false),
    labels: jsonb("labels").$type<string[]>(),
    rawHeaders: jsonb("raw_headers").$type<Record<string, string>>(),
    embedding: vector("embedding", { dimensions: 1536 }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("emails_raw_workspace_user_gmail_msg_idx").on(
      table.workspaceId,
      table.userId,
      table.gmailMessageId,
    ),
    index("emails_raw_user_thread_idx").on(table.userId, table.gmailThreadId),
    index("emails_raw_user_triage_idx").on(table.userId, table.triage),
    index("emails_raw_user_thread_state_idx").on(table.userId, table.threadState),
    index("emails_raw_user_date_idx").on(table.userId, table.date),
    index("emails_raw_embedding_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  ],
);

// ── OAuth Tokens ───────────────────────────────────────────────────────────

export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: serial("id").primaryKey(),
    workspaceId: workspaceId().references(() => workspaces.id),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull().default("google"),
    email: text("email"),
    refreshToken: text("refresh_token").notNull(),
    scopes: text("scopes"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("oauth_tokens_workspace_user_provider_idx").on(
      table.workspaceId,
      table.userId,
      table.provider,
    ),
    index("oauth_tokens_email_idx").on(table.email),
  ],
);
// ── Voice Calls ─────────────────────────────────────────────────────────────

export const voiceCalls = pgTable(
  "voice_calls",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    conversationId: text("conversation_id").notNull().unique(),
    agentId: text("agent_id"),
    direction: text("direction").notNull().default("outbound"),
    phoneNumber: text("phone_number"),
    personName: text("person_name"),
    slackUserId: text("slack_user_id"),
    status: text("status").notNull().default("in_progress"),
    durationSeconds: integer("duration_seconds"),
    transcript: jsonb("transcript"),
    summary: text("summary"),
    callContext: text("call_context"),
    dynamicVariables: jsonb("dynamic_variables").$type<Record<string, unknown>>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("voice_calls_agent_id_idx").on(table.agentId),
    index("voice_calls_status_idx").on(table.status),
    index("voice_calls_created_at_idx").on(table.createdAt),
  ],
);

// ── Action Log (tool call audit trail) ────────────────────────────────────────

export const actionLog = pgTable(
  "action_log",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: workspaceId().references(() => workspaces.id),
    toolName: text("tool_name").notNull(),
    params: jsonb("params").notNull(),
    triggerType: text("trigger_type").notNull(),
    triggeredBy: text("triggered_by").notNull(),
    jobId: uuid("job_id").references(() => jobs.id),
    credentialName: text("credential_name"),
    status: text("status").notNull(),
    result: jsonb("result"),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "action_log_status_check",
      sql`${table.status} IN ('executed','failed')`,
    ),
    check(
      "action_log_trigger_type_check",
      sql`${table.triggerType} IN ('user_message','scheduled_job','autonomous')`,
    ),
    unique("action_log_workspace_idempotency_key_unique").on(table.workspaceId, table.idempotencyKey),
    index("action_log_tool_name_idx").on(table.toolName),
    index("action_log_triggered_by_idx").on(table.triggeredBy),
    index("action_log_status_idx").on(table.status),
    index("action_log_created_at_idx").on(table.createdAt),
  ],
);

// ── Type exports ───────────────────────────────────────────────────────────

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
/** @deprecated Use `users` instead */
export const userProfiles = users;
/** @deprecated Use `User` instead */
export type UserProfile = User;
/** @deprecated Use `NewUser` instead */
export type NewUserProfile = NewUser;
export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
export type EntityAlias = typeof entityAliases.$inferSelect;
export type NewEntityAlias = typeof entityAliases.$inferInsert;
export type MemoryEntity = typeof memoryEntities.$inferSelect;
export type NewMemoryEntity = typeof memoryEntities.$inferInsert;
export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
export type Setting = typeof settings.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Note = typeof notes.$inferSelect;
export type Resource = typeof resources.$inferSelect;
export type NewResource = typeof resources.$inferInsert;
export type EventLock = typeof eventLocks.$inferSelect;
export type NewEventLock = typeof eventLocks.$inferInsert;
export type ConversationLock = typeof conversationLocks.$inferSelect;
export type NewConversationLock = typeof conversationLocks.$inferInsert;
export type ErrorEvent = typeof errorEvents.$inferSelect;
export type NewErrorEvent = typeof errorEvents.$inferInsert;
export type JobExecution = typeof jobExecutions.$inferSelect;
export type NewJobExecution = typeof jobExecutions.$inferInsert;
export type OAuthToken = typeof oauthTokens.$inferSelect;
export type NewOAuthToken = typeof oauthTokens.$inferInsert;
export type EmailRaw = typeof emailsRaw.$inferSelect;
export type NewEmailRaw = typeof emailsRaw.$inferInsert;
export type Address = typeof addresses.$inferSelect;
export type NewAddress = typeof addresses.$inferInsert;
export type VoiceCall = typeof voiceCalls.$inferSelect;
export type NewVoiceCall = typeof voiceCalls.$inferInsert;
export type ActionLog = typeof actionLog.$inferSelect;
export type NewActionLog = typeof actionLog.$inferInsert;

/** Context for tools that need to know the current conversation's routing. */
export interface ScheduleContext {
  userId?: string;
  channelId?: string;
  threadTs?: string;
  timezone?: string;
}
// ── Feedback ────────────────────────────────────────────────────────────────

export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: workspaceId().references(() => workspaces.id),
    messageTs: text("message_ts").notNull(),
    channelId: text("channel_id").notNull(),
    userId: text("user_id").notNull(),
    value: text("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("feedback_workspace_unique_vote").on(table.workspaceId, table.messageTs, table.channelId, table.userId),
  ],
);

export type Feedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;

// ── API Credentials (per-user encrypted credential storage) ─────────────────

export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: workspaceId().references(() => workspaces.id),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull().default("token"),
    tokenUrl: text("token_url"),
    value: text("value").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    sandboxEnvName: text("sandbox_env_name"),
    scope: text("scope").notNull().default("member"),
    expiresAt: timestamptz("expires_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("credentials_workspace_owner_id_name_unique").on(table.workspaceId, table.ownerId, table.name),
    check(
      "credentials_name_check",
      sql`${table.name} ~ '^[a-z][a-z0-9_]{1,62}$'`,
    ),
    check(
      "credentials_type_check",
      sql`${table.type} IN ('token', 'oauth_client')`,
    ),
    check(
      "credentials_scope_check",
      sql`${table.scope} IN ('member', 'power_user', 'admin', 'owner', 'per_user')`,
    ),
  ],
);

export const credentialGrants = pgTable(
  "credential_grants",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: workspaceId().references(() => workspaces.id),
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => credentials.id, { onDelete: "cascade" }),
    granteeId: text("grantee_id").notNull(),
    permission: text("permission").notNull(),
    grantedBy: text("granted_by").notNull(),
    grantedAt: timestamptz("granted_at").notNull().defaultNow(),
    revokedAt: timestamptz("revoked_at"),
  },
  (table) => [
    unique("credential_grants_workspace_credential_id_grantee_id_unique").on(
      table.workspaceId,
      table.credentialId,
      table.granteeId,
    ),
    index("idx_grants_grantee").on(table.granteeId),
    check(
      "credential_grants_permission_check",
      sql`${table.permission} IN ('read', 'write', 'admin')`,
    ),
  ],
);

export const credentialAuditLog = pgTable(
  "credential_audit_log",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: workspaceId().references(() => workspaces.id),
    credentialId: uuid("credential_id").references(() => credentials.id, {
      onDelete: "set null",
    }),
    credentialName: text("credential_name").notNull(),
    accessedBy: text("accessed_by").notNull(),
    action: text("action").notNull(),
    context: text("context"),
    timestamp: timestamptz("timestamp").notNull().defaultNow(),
  },
  (table) => [
    index("idx_audit_credential").on(table.credentialId, table.timestamp),
    index("idx_audit_accessed_by").on(table.accessedBy, table.timestamp),
    check(
      "credential_audit_log_action_check",
      sql`${table.action} IN ('read','create','update','delete','grant','revoke','use','expired_access_attempt')`,
    ),
  ],
);

export type Credential = typeof credentials.$inferSelect;
export type NewCredential = typeof credentials.$inferInsert;
export type CredentialGrant = typeof credentialGrants.$inferSelect;
export type NewCredentialGrant = typeof credentialGrants.$inferInsert;
export type CredentialAuditEntry = typeof credentialAuditLog.$inferSelect;
export type NewCredentialAuditEntry = typeof credentialAuditLog.$inferInsert;

// ── Content (blog/docs index for semantic search + related posts) ───────────

export const content = pgTable(
  "content",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    slug: text("slug").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    excerpt: text("excerpt"),
    author: text("author"),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    publishedAt: timestamptz("published_at"),
    readingMinutes: integer("reading_minutes"),
    ogImage: text("og_image"),
    embedding: vector("embedding", { dimensions: 1536 }),
    rawPath: text("raw_path").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("content_slug_idx").on(table.slug),
    index("content_type_idx").on(table.type),
    index("content_published_at_idx").on(table.publishedAt),
    index("content_tags_idx").using("gin", table.tags),
    index("content_embedding_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  ],
);

export type Content = typeof content.$inferSelect;
export type NewContent = typeof content.$inferInsert;
export type ConversationTrace = typeof conversationTraces.$inferSelect;
export type NewConversationTrace = typeof conversationTraces.$inferInsert;
export type ConversationMessage = typeof conversationMessages.$inferSelect;
export type NewConversationMessage = typeof conversationMessages.$inferInsert;
export type ConversationPart = typeof conversationParts.$inferSelect;
export type NewConversationPart = typeof conversationParts.$inferInsert;
export type ModelPricing = typeof modelPricing.$inferSelect;
export type NewModelPricing = typeof modelPricing.$inferInsert;
