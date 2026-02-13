-- Aura v0: Initial database schema
-- Requires: Neon PostgreSQL with pgvector extension enabled

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Enums
DO $$ BEGIN
  CREATE TYPE channel_type AS ENUM ('dm', 'public_channel', 'private_channel');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE message_role AS ENUM ('user', 'assistant');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE memory_type AS ENUM ('fact', 'decision', 'personal', 'relationship', 'sentiment', 'open_thread');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Messages table: raw conversation log
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slack_ts TEXT NOT NULL,
  slack_thread_ts TEXT,
  channel_id TEXT NOT NULL,
  channel_type channel_type NOT NULL,
  user_id TEXT NOT NULL,
  role message_role NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS messages_slack_ts_idx ON messages (slack_ts);
CREATE INDEX IF NOT EXISTS messages_channel_created_idx ON messages (channel_id, created_at);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (slack_thread_ts);

-- Memories table: extracted structured facts with vector embeddings
CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  type memory_type NOT NULL,
  source_message_id UUID REFERENCES messages(id),
  source_channel_type channel_type NOT NULL,
  related_user_ids TEXT[] NOT NULL DEFAULT '{}'::text[],
  embedding vector(1536),
  relevance_score REAL NOT NULL DEFAULT 1.0,
  shareable INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HNSW index for fast approximate nearest neighbor search
CREATE INDEX IF NOT EXISTS memories_embedding_idx ON memories
  USING hnsw (embedding vector_cosine_ops);

-- GIN index for user-based filtering on array column
CREATE INDEX IF NOT EXISTS memories_related_users_idx ON memories
  USING gin (related_user_ids);

CREATE INDEX IF NOT EXISTS memories_type_idx ON memories (type);
CREATE INDEX IF NOT EXISTS memories_created_at_idx ON memories (created_at);

-- User profiles table: auto-generated from conversations
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slack_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  timezone TEXT,
  communication_style JSONB DEFAULT '{"verbosity":"moderate","formality":"neutral","emojiUsage":"light","preferredFormat":"mixed"}'::jsonb,
  known_facts JSONB DEFAULT '{}'::jsonb,
  interaction_count INTEGER NOT NULL DEFAULT 0,
  last_interaction_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_slack_user_id_idx ON user_profiles (slack_user_id);

-- Channels table: metadata cache
CREATE TABLE IF NOT EXISTS channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slack_channel_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type channel_type NOT NULL,
  topic TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS channels_slack_channel_id_idx ON channels (slack_channel_id);
