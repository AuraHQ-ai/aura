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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("user_profiles_slack_user_id_idx").on(table.slackUserId),
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

/** Context for tools that need to know the current conversation's routing. */
export interface ScheduleContext {
  userId?: string;
  channelId?: string;
  threadTs?: string;
}