import {
  pgTable,
  uuid,
  text,
  pgEnum,
  timestamp,
  real,
  integer,
  jsonb,
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

export const messageRoleEnum = pgEnum("message_role", ["user", "assistant"]);

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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("messages_slack_ts_idx").on(table.slackTs),
    index("messages_channel_created_idx").on(table.channelId, table.createdAt),
    index("messages_thread_idx").on(table.slackThreadTs),
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

// ── Type exports ───────────────────────────────────────────────────────────

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
export type UserProfile = typeof userProfiles.$inferSelect;
export type NewUserProfile = typeof userProfiles.$inferInsert;
export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
