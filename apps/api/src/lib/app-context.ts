import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { appContextCache, type AppContextEntity } from "@aura/db/schema";
import { logger } from "./logger.js";

export type { AppContextEntity };

// ── Slack agent context (app_context) — issue #1295 ─────────────────────────
// agent_view apps receive `app_context_changed` events describing what the
// user currently has open (channel, DM, thread, canvas, list), and — once
// subscribed to that event — an `app_context` field directly on `message.im`
// events. We cache the latest context per user (short TTL, Postgres) and
// inject a small "user's current view" hint into the DM prompt so artifact
// drops without framing get read artifact-first instead of memory-first.

/** Cached view context older than this is considered stale and ignored. */
export const APP_CONTEXT_TTL_MS = 5 * 60 * 1000;

/**
 * Upsert the latest app_context entities for a user. Called from the
 * `app_context_changed` event handler. An empty `entities` array is stored
 * too — it means the user navigated away, and must overwrite a previous
 * context rather than leave it dangling.
 */
export async function upsertAppContext(params: {
  workspaceId: string;
  userId: string;
  entities: AppContextEntity[];
  eventTs?: string;
}): Promise<void> {
  const { workspaceId, userId, entities, eventTs } = params;
  await db
    .insert(appContextCache)
    .values({
      workspaceId,
      userId,
      entities,
      eventTs: eventTs ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [appContextCache.workspaceId, appContextCache.userId],
      set: {
        entities,
        eventTs: eventTs ?? null,
        updatedAt: new Date(),
      },
    });
}

/**
 * Read the cached app_context for a user, ignoring stale rows
 * (older than APP_CONTEXT_TTL_MS). Soft-fails to null — the pipeline
 * must never break because this cache is unavailable.
 */
export async function readCachedAppContext(
  userId: string,
  workspaceId: string,
  now: number = Date.now(),
): Promise<AppContextEntity[] | null> {
  try {
    const rows = await db
      .select()
      .from(appContextCache)
      .where(
        and(
          eq(appContextCache.workspaceId, workspaceId),
          eq(appContextCache.userId, userId),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    if (now - row.updatedAt.getTime() > APP_CONTEXT_TTL_MS) return null;
    return Array.isArray(row.entities) && row.entities.length > 0
      ? row.entities
      : null;
  } catch (error: any) {
    logger.warn("Failed to read app context cache", {
      error: error?.message,
      userId,
    });
    return null;
  }
}

/**
 * Extract the inline `app_context` payload from a Slack message event
 * (present on `message.im` when the app subscribes to `app_context_changed`).
 */
export function extractEventAppContext(
  event: unknown,
): AppContextEntity[] | null {
  const appContext = (event as { app_context?: unknown })?.app_context as
    | { entities?: unknown }
    | undefined;
  const entities = appContext?.entities;
  if (Array.isArray(entities) && entities.length > 0) {
    return entities as AppContextEntity[];
  }
  return null;
}

/**
 * Resolve the user's current view context at message time:
 * prefer the inline `app_context` on the event (freshest), otherwise fall
 * back to the cached context from the latest `app_context_changed` event.
 */
export async function resolveAppContextForMessage(params: {
  event: unknown;
  userId: string;
  workspaceId?: string;
}): Promise<AppContextEntity[] | null> {
  const fromEvent = extractEventAppContext(params.event);
  if (fromEvent) return fromEvent;
  return readCachedAppContext(params.userId, params.workspaceId ?? "default");
}

// ── Rendering ────────────────────────────────────────────────────────────────
// Entities are typed refs (e.g. slack#/types/channel_id). Render them
// human-readable without extra Slack API calls at injection time.

const ENTITY_RENDERERS: Record<string, (value: string) => string> = {
  "slack#/types/channel_id": (v) => `a channel (<#${v}>)`,
  "slack#/types/user_id": (v) => `a DM with <@${v}>`,
  "slack#/types/thread_ts": (v) => `a thread (thread_ts ${v})`,
  "slack#/types/message_ts": (v) => `a message (ts ${v})`,
  "slack#/types/canvas_id": (v) => `a canvas (id ${v})`,
  "slack#/types/list_id": (v) => `a Slack List (id ${v})`,
  "slack#/types/file_id": (v) => `a file (id ${v})`,
};

/** Render app_context entities as a short human-readable list. */
export function renderAppContextEntities(
  entities: AppContextEntity[],
): string {
  return entities
    .filter((e) => e && typeof e.type === "string" && typeof e.value === "string" && e.value)
    .map((e) => {
      const renderer = ENTITY_RENDERERS[e.type];
      if (renderer) return renderer(e.value);
      // Unknown type: strip the "slack#/types/" prefix for readability.
      const label = e.type.replace(/^slack#\/types\//, "").replace(/_/g, " ");
      return `${label} ${e.value}`;
    })
    .join("; ");
}

/**
 * Build the "User's current view" system-context block for the DM prompt.
 * Returns null when nothing renders. Kept deliberately small (~100 tokens).
 */
export function buildAppContextBlock(
  entities: AppContextEntity[],
): string | null {
  const rendered = renderAppContextEntities(entities);
  if (!rendered) return null;
  return `## User's current view
The user currently has open: ${rendered}. If their message references "this" or drops an artifact (link, canvas, list item) without framing, it very likely refers to what they have open — read that artifact FIRST (thread replies, canvas, list item, channel history) before falling back to memory retrieval.`;
}
