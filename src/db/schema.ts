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
  vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── Enums ──────────────────────────────────────────────────────────────────

export const channelTypeEnum = pgEnum("channel_type", [
  "dm",
  "public_channel",
  "private_channel",
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
  "relationship",
  "sentiment",
  "open_thread",
]);

// Helper for timestamptz columns
const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

// ── Messages ───────────────────────────────────────────────────────────────

export const messages = pgTable(
  "messages",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    slackTs: text("slack_ts").notNull(),
    slackThreadTs: text("slack_thread_ts"),
    channelId: text("channel_id").notNull(),
    channelType: channelTypeEnum("channel_type").notNull(),
    userId: text("user_id").notNull(),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    embedding: vector("embedding", { dimensions: 1536 }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("messages_slack_ts_idx").on(table.slackTs),
    index("messages_channel_created_idx").on(table.channelId, table.createdAt),
    index("messages_thread_idx").on(table.slackThreadTs),
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
    content: text("content").notNull(),
    type: memoryTypeEnum("type").notNull(),
    sourceMessageId: uuid("source_message_id").references(() => messages.id),
    sourceChannelType: channelTypeEnum("source_channel_type").notNull(),
    relatedUserIds: text("related_user_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    embedding: vector("embedding", { dimensions: 1536 }),
    relevanceScore: real("relevance_score").notNull().default(1.0),
    shareable: integer("shareable").notNull().default(0),
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
  ],
);

// ── User Profiles ──────────────────────────────────────────────────────────

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

export const userProfiles = pgTable(
  "user_profiles",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    slackUserId: text("slack_user_id").notNull(),
    displayName: text("display_name").notNull(),
    timezone: text("timezone"),
    personId: uuid("person_id").references(() => people.id),
    communicationStyle: jsonb("communication_style")
      .$type<CommunicationStyle>()
      .default({
        verbosity: "moderate",
        formality: "neutral",
        emojiUsage: "light",
        preferredFormat: "mixed",
      }),
    knownFacts: jsonb("known_facts").$type<KnownFacts>().default({}),
    interactionCount: integer("interaction_count").notNull().default(0),
    lastInteractionAt: timestamptz("last_interaction_at"),
    lastProfileConsolidation: timestamptz("last_profile_consolidation"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("user_profiles_slack_user_id_idx").on(table.slackUserId),
  ],
);

// ── People ─────────────────────────────────────────────────────────────────

export const people = pgTable("people", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  displayName: text("display_name"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

// ── Addresses ──────────────────────────────────────────────────────────────

export const addresses = pgTable(
  "addresses",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    channel: text("channel").notNull(),
    value: text("value").notNull(),
    confidence: real("confidence").default(1.0),
    source: text("source"),
    verifiedAt: timestamptz("verified_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("addresses_channel_value_idx").on(table.channel, table.value),
    index("addresses_person_id_idx").on(table.personId),
  ],
);

// ── Channels ───────────────────────────────────────────────────────────────

export const channels = pgTable(
  "channels",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    slackChannelId: text("slack_channel_id").notNull(),
    name: text("name").notNull(),
    type: channelTypeEnum("type").notNull(),
    topic: text("topic"),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("channels_slack_channel_id_idx").on(table.slackChannelId),
  ],
);

// ── Settings ────────────────────────────────────────────────────────────────

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by"),
});

// ── Notes (agent scratchpad with three-tier hierarchy) ──────────────────────

export const notes = pgTable(
  "notes",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    topic: text("topic").notNull(),
    content: text("content").notNull(),
    category: text("category").notNull().default("knowledge"),
    embedding: vector("embedding", { dimensions: 1536 }),
    expiresAt: timestamptz("expires_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("notes_topic_idx").on(table.topic),
    index("notes_category_idx").on(table.category),
    index("notes_embedding_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
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
    name: text("name").notNull(),
    description: text("description").notNull(),
    playbook: text("playbook"),
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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("jobs_name_idx").on(table.name),
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

// ── Event Locks (dedup for Slack duplicate events) ──────────────────────────

export const eventLocks = pgTable(
  "event_locks",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    eventTs: text("event_ts").notNull(),
    channelId: text("channel_id").notNull(),
    claimedAt: timestamptz("claimed_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("event_locks_event_ts_channel_id_idx").on(
      table.eventTs,
      table.channelId,
    ),
  ],
);

// ── Error Events ────────────────────────────────────────────────────────────

export const errorEvents = pgTable(
  "error_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("emails_raw_user_gmail_msg_idx").on(
      table.userId,
      table.gmailMessageId,
    ),
    index("emails_raw_user_thread_idx").on(table.userId, table.gmailThreadId),
    index("emails_raw_user_triage_idx").on(table.userId, table.triage),
    index("emails_raw_user_thread_state_idx").on(table.userId, table.threadState),
    index("emails_raw_user_date_idx").on(table.userId, table.date),
  ],
);

// ── OAuth Tokens ───────────────────────────────────────────────────────────

export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull().default("google"),
    email: text("email"),
    refreshToken: text("refresh_token").notNull(),
    scopes: text("scopes"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("oauth_tokens_user_provider_idx").on(
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

// ── Type exports ───────────────────────────────────────────────────────────

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
export type UserProfile = typeof userProfiles.$inferSelect;
export type NewUserProfile = typeof userProfiles.$inferInsert;
export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
export type Setting = typeof settings.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Note = typeof notes.$inferSelect;
export type EventLock = typeof eventLocks.$inferSelect;
export type NewEventLock = typeof eventLocks.$inferInsert;
export type ErrorEvent = typeof errorEvents.$inferSelect;
export type NewErrorEvent = typeof errorEvents.$inferInsert;
export type JobExecution = typeof jobExecutions.$inferSelect;
export type NewJobExecution = typeof jobExecutions.$inferInsert;
export type OAuthToken = typeof oauthTokens.$inferSelect;
export type NewOAuthToken = typeof oauthTokens.$inferInsert;
export type EmailRaw = typeof emailsRaw.$inferSelect;
export type NewEmailRaw = typeof emailsRaw.$inferInsert;
export type Person = typeof people.$inferSelect;
export type NewPerson = typeof people.$inferInsert;
export type Address = typeof addresses.$inferSelect;
export type NewAddress = typeof addresses.$inferInsert;
export type VoiceCall = typeof voiceCalls.$inferSelect;
export type NewVoiceCall = typeof voiceCalls.$inferInsert;

/** Context for tools that need to know the current conversation's routing. */
export interface ScheduleContext {
  userId?: string;
  channelId?: string;
  threadTs?: string;
  timezone?: string;
}