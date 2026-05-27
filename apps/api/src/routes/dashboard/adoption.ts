import { createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { createDashboardApp, errorSchema } from "./schemas.js";

export const dashboardAdoptionApp = createDashboardApp();

const AURA_USER_ID = "U0AFEC1C69F";
const ADOPTION_TIMEZONE = "Europe/Amsterdam";
const DEFAULT_RANGE_DAYS = 180;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const adoptionQuerySchema = z
  .object({
    start: isoDate.optional(),
    end: isoDate.optional(),
  })
  .refine((q) => (q.start === undefined) === (q.end === undefined), {
    message: "start and end must both be provided together",
    path: ["end"],
  })
  .refine((q) => !q.start || !q.end || q.start <= q.end, {
    message: "start must be on or before end",
    path: ["start"],
  });

type QueryResult<T> = { rows?: T[] } | T[];

function getRows<T>(result: QueryResult<T>): T[] {
  return Array.isArray(result) ? result : result.rows ?? [];
}

function formatAmsterdamDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ADOPTION_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function addDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0));
  return date.toISOString().slice(0, 10);
}

function getDateRange(start: string | undefined, end: string | undefined): { start: string; end: string } {
  if (start && end) return { start, end };

  const defaultEnd = formatAmsterdamDate(new Date());
  return {
    start: addDays(defaultEnd, -(DEFAULT_RANGE_DAYS - 1)),
    end: defaultEnd,
  };
}

function numberValue(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

function percentage(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

const getAdoptionRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Adoption"],
  summary: "Get Aura adoption KPIs (default: last 180 days in Europe/Amsterdam)",
  request: {
    query: adoptionQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.any(),
        },
      },
      description: "Success",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardAdoptionApp.openapi(getAdoptionRoute, async (c) => {
  try {
    const q = c.req.valid("query");
    const { start, end } = getDateRange(q.start, q.end);

    const activityRows = getRows<{
      date: string;
      is_weekend: boolean;
      dau: number | string;
      wau: number | string;
      mau: number | string;
      dau_mau_ratio: number | string;
      wau_mau_ratio: number | string;
    }>(await db.execute(sql`
      WITH params AS (
        SELECT
          ${start}::date AS start_day,
          ${end}::date AS end_day,
          ${AURA_USER_ID}::text AS aura_user_id,
          ${ADOPTION_TIMEZONE}::text AS adoption_tz
      ),
      days AS (
        SELECT generate_series(p.start_day, p.end_day, '1 day'::interval)::date AS day
        FROM params p
      ),
      active_msgs AS (
        SELECT
          (m.created_at AT TIME ZONE p.adoption_tz)::date AS day,
          m.user_id
        FROM messages m
        CROSS JOIN params p
        WHERE m.role = 'user'
          AND m.user_id != p.aura_user_id
          AND m.created_at >= ((p.start_day - INTERVAL '27 days')::timestamp AT TIME ZONE p.adoption_tz)
          AND m.created_at < ((p.end_day + 1)::timestamp AT TIME ZONE p.adoption_tz)
          AND (
            m.channel_type = 'dm'
            OR m.content ILIKE ('%<@' || p.aura_user_id || '>%')
          )
      ),
      counts AS (
        SELECT
          d.day,
          EXTRACT(ISODOW FROM d.day)::int IN (6, 7) AS is_weekend,
          COUNT(DISTINCT a.user_id) FILTER (WHERE a.day = d.day)::int AS dau,
          COUNT(DISTINCT a.user_id) FILTER (WHERE a.day BETWEEN d.day - 6 AND d.day)::int AS wau,
          COUNT(DISTINCT a.user_id) FILTER (WHERE a.day BETWEEN d.day - 27 AND d.day)::int AS mau
        FROM days d
        LEFT JOIN active_msgs a ON a.day BETWEEN d.day - 27 AND d.day
        GROUP BY d.day
      )
      SELECT
        day::text AS date,
        is_weekend,
        dau,
        wau,
        mau,
        ROUND(CASE WHEN mau = 0 THEN 0 ELSE (dau::numeric / mau) * 100 END, 1) AS dau_mau_ratio,
        ROUND(CASE WHEN mau = 0 THEN 0 ELSE (wau::numeric / mau) * 100 END, 1) AS wau_mau_ratio
      FROM counts
      ORDER BY day;
    `));

    const [summaryRow] = getRows<{
      workspace_members: number | string;
      ever_talked: number | string;
      dau: number | string;
      wau: number | string;
      mau: number | string;
      previous_dau: number | string;
      previous_wau: number | string;
      previous_mau: number | string;
      power_users: number | string;
      new_users_7d: number | string;
      new_users_28d: number | string;
      returning_mau_users: number | string;
      dm_messages_28d: number | string;
      mention_messages_28d: number | string;
      total_messages_7d: number | string;
      week1_eligible_users: number | string;
      week1_returned_users: number | string;
    }>(await db.execute(sql`
      WITH params AS (
        SELECT
          ${end}::date AS end_day,
          ${AURA_USER_ID}::text AS aura_user_id,
          ${ADOPTION_TIMEZONE}::text AS adoption_tz
      ),
      active_msgs AS (
        SELECT
          (m.created_at AT TIME ZONE p.adoption_tz)::date AS day,
          m.user_id,
          CASE WHEN m.channel_type = 'dm' THEN 'dm' ELSE 'mention' END AS source
        FROM messages m
        CROSS JOIN params p
        WHERE m.role = 'user'
          AND m.user_id != p.aura_user_id
          AND m.created_at < ((p.end_day + 1)::timestamp AT TIME ZONE p.adoption_tz)
          AND (
            m.channel_type = 'dm'
            OR m.content ILIKE ('%<@' || p.aura_user_id || '>%')
          )
      ),
      activity_by_user AS (
        SELECT
          p.end_day,
          a.user_id,
          COUNT(*) FILTER (WHERE a.day BETWEEN p.end_day - 6 AND p.end_day)::int AS messages_7d,
          COUNT(DISTINCT a.day) FILTER (WHERE a.day BETWEEN p.end_day - 6 AND p.end_day)::int AS active_days_7d,
          BOOL_OR(a.day = p.end_day) AS is_dau,
          BOOL_OR(a.day BETWEEN p.end_day - 6 AND p.end_day) AS is_wau,
          BOOL_OR(a.day BETWEEN p.end_day - 27 AND p.end_day) AS is_mau,
          BOOL_OR(a.day BETWEEN p.end_day - 55 AND p.end_day - 28) AS was_previous_mau
        FROM active_msgs a
        CROSS JOIN params p
        GROUP BY p.end_day, a.user_id
      ),
      firsts AS (
        SELECT
          user_id,
          MIN(day) AS first_day,
          date_trunc('week', MIN(day)::timestamp)::date AS first_week
        FROM active_msgs
        GROUP BY user_id
      ),
      week1_eligible AS (
        SELECT f.user_id, f.first_week
        FROM firsts f
        CROSS JOIN params p
        WHERE f.first_week <= date_trunc('week', p.end_day::timestamp)::date - 7
      ),
      week1_returned AS (
        SELECT DISTINCT e.user_id
        FROM week1_eligible e
        JOIN active_msgs a ON a.user_id = e.user_id
          AND a.day >= e.first_week + 7
          AND a.day < e.first_week + 14
      ),
      current_mau AS (
        SELECT user_id FROM activity_by_user WHERE is_mau
      ),
      previous_mau AS (
        SELECT user_id FROM activity_by_user WHERE was_previous_mau
      )
      SELECT
        (
          SELECT COUNT(*)::int
          FROM users u
          CROSS JOIN params p
          WHERE u.slack_user_id IS NOT NULL
            AND u.slack_user_id != p.aura_user_id
        ) AS workspace_members,
        (SELECT COUNT(*)::int FROM firsts) AS ever_talked,
        (SELECT COUNT(*)::int FROM activity_by_user WHERE is_dau) AS dau,
        (SELECT COUNT(*)::int FROM activity_by_user WHERE is_wau) AS wau,
        (SELECT COUNT(*)::int FROM activity_by_user WHERE is_mau) AS mau,
        (SELECT COUNT(DISTINCT user_id)::int FROM active_msgs WHERE day = p.end_day - 7) AS previous_dau,
        (SELECT COUNT(DISTINCT user_id)::int FROM active_msgs WHERE day BETWEEN p.end_day - 13 AND p.end_day - 7) AS previous_wau,
        (SELECT COUNT(DISTINCT user_id)::int FROM active_msgs WHERE day BETWEEN p.end_day - 55 AND p.end_day - 28) AS previous_mau,
        (SELECT COUNT(*)::int FROM activity_by_user WHERE active_days_7d >= 5) AS power_users,
        (SELECT COUNT(*)::int FROM firsts WHERE first_day BETWEEN p.end_day - 6 AND p.end_day) AS new_users_7d,
        (SELECT COUNT(*)::int FROM firsts WHERE first_day BETWEEN p.end_day - 27 AND p.end_day) AS new_users_28d,
        (SELECT COUNT(*)::int FROM current_mau cm JOIN previous_mau pm USING (user_id)) AS returning_mau_users,
        (SELECT COUNT(*)::int FROM active_msgs WHERE day BETWEEN p.end_day - 27 AND p.end_day AND source = 'dm') AS dm_messages_28d,
        (SELECT COUNT(*)::int FROM active_msgs WHERE day BETWEEN p.end_day - 27 AND p.end_day AND source = 'mention') AS mention_messages_28d,
        (SELECT COUNT(*)::int FROM active_msgs WHERE day BETWEEN p.end_day - 6 AND p.end_day) AS total_messages_7d,
        (SELECT COUNT(*)::int FROM week1_eligible) AS week1_eligible_users,
        (SELECT COUNT(*)::int FROM week1_returned) AS week1_returned_users
      FROM params p;
    `));

    const cohortRows = getRows<{
      cohort_week: string;
      cohort_size: number | string;
      week_offset: number | string;
      active_users: number | string;
      retention_pct: number | string;
    }>(await db.execute(sql`
      WITH params AS (
        SELECT
          ${start}::date AS start_day,
          ${end}::date AS end_day,
          ${AURA_USER_ID}::text AS aura_user_id,
          ${ADOPTION_TIMEZONE}::text AS adoption_tz
      ),
      active_msgs AS (
        SELECT
          (m.created_at AT TIME ZONE p.adoption_tz)::date AS day,
          m.user_id
        FROM messages m
        CROSS JOIN params p
        WHERE m.role = 'user'
          AND m.user_id != p.aura_user_id
          AND m.created_at < ((p.end_day + 1)::timestamp AT TIME ZONE p.adoption_tz)
          AND (
            m.channel_type = 'dm'
            OR m.content ILIKE ('%<@' || p.aura_user_id || '>%')
          )
      ),
      active_weeks AS (
        SELECT DISTINCT
          user_id,
          date_trunc('week', day::timestamp)::date AS active_week
        FROM active_msgs
      ),
      firsts AS (
        SELECT
          user_id,
          MIN(active_week) AS first_week
        FROM active_weeks
        GROUP BY user_id
      ),
      cohort_users AS (
        SELECT f.user_id, f.first_week
        FROM firsts f
        CROSS JOIN params p
        WHERE f.first_week BETWEEN date_trunc('week', p.start_day::timestamp)::date
          AND date_trunc('week', p.end_day::timestamp)::date
      ),
      cohorts AS (
        SELECT first_week, COUNT(*)::int AS cohort_size
        FROM cohort_users
        GROUP BY first_week
      ),
      grid AS (
        SELECT
          c.first_week,
          c.cohort_size,
          generate_series(
            0,
            ((date_trunc('week', p.end_day::timestamp)::date - c.first_week) / 7)::int
          ) AS week_offset
        FROM cohorts c
        CROSS JOIN params p
      ),
      retention AS (
        SELECT
          cu.first_week,
          ((aw.active_week - cu.first_week) / 7)::int AS week_offset,
          COUNT(DISTINCT cu.user_id)::int AS active_users
        FROM cohort_users cu
        JOIN active_weeks aw ON aw.user_id = cu.user_id
          AND aw.active_week >= cu.first_week
        GROUP BY cu.first_week, ((aw.active_week - cu.first_week) / 7)::int
      )
      SELECT
        g.first_week::text AS cohort_week,
        g.cohort_size,
        g.week_offset,
        COALESCE(r.active_users, 0)::int AS active_users,
        ROUND((COALESCE(r.active_users, 0)::numeric / NULLIF(g.cohort_size, 0)) * 100, 1) AS retention_pct
      FROM grid g
      LEFT JOIN retention r ON r.first_week = g.first_week AND r.week_offset = g.week_offset
      ORDER BY g.first_week DESC, g.week_offset;
    `));

    const teamRows = getRows<{
      team: string;
      member_count: number | string;
      dau: number | string;
      wau: number | string;
      mau: number | string;
      dormant_users: number | string;
      top_user_id: string | null;
      top_user_name: string | null;
      top_user_messages: number | string | null;
    }>(await db.execute(sql`
      WITH params AS (
        SELECT
          ${end}::date AS end_day,
          ${AURA_USER_ID}::text AS aura_user_id,
          ${ADOPTION_TIMEZONE}::text AS adoption_tz
      ),
      user_base AS (
        SELECT
          u.slack_user_id,
          u.display_name,
          COALESCE(NULLIF(u.known_facts->>'team', ''), 'Unassigned') AS team
        FROM users u
        CROSS JOIN params p
        WHERE u.slack_user_id IS NOT NULL
          AND u.slack_user_id != p.aura_user_id
      ),
      active_msgs AS (
        SELECT
          (m.created_at AT TIME ZONE p.adoption_tz)::date AS day,
          m.user_id
        FROM messages m
        CROSS JOIN params p
        WHERE m.role = 'user'
          AND m.user_id != p.aura_user_id
          AND m.created_at >= ((p.end_day - 55)::timestamp AT TIME ZONE p.adoption_tz)
          AND m.created_at < ((p.end_day + 1)::timestamp AT TIME ZONE p.adoption_tz)
          AND (
            m.channel_type = 'dm'
            OR m.content ILIKE ('%<@' || p.aura_user_id || '>%')
          )
      ),
      activity_by_user AS (
        SELECT
          a.user_id,
          MAX(a.day) AS last_seen,
          COUNT(*) FILTER (WHERE a.day BETWEEN p.end_day - 27 AND p.end_day)::int AS messages_28d,
          BOOL_OR(a.day = p.end_day) AS is_dau,
          BOOL_OR(a.day BETWEEN p.end_day - 6 AND p.end_day) AS is_wau,
          BOOL_OR(a.day BETWEEN p.end_day - 27 AND p.end_day) AS is_mau,
          BOOL_OR(a.day BETWEEN p.end_day - 55 AND p.end_day - 28) AS was_previous_mau
        FROM active_msgs a
        CROSS JOIN params p
        GROUP BY a.user_id
      ),
      ranked_users AS (
        SELECT
          ub.team,
          ub.slack_user_id,
          ub.display_name,
          COALESCE(abu.messages_28d, 0) AS messages_28d,
          ROW_NUMBER() OVER (
            PARTITION BY ub.team
            ORDER BY COALESCE(abu.messages_28d, 0) DESC, ub.display_name
          ) AS rn
        FROM user_base ub
        LEFT JOIN activity_by_user abu ON abu.user_id = ub.slack_user_id
      )
      SELECT
        ub.team,
        COUNT(*)::int AS member_count,
        COUNT(*) FILTER (WHERE abu.is_dau)::int AS dau,
        COUNT(*) FILTER (WHERE abu.is_wau)::int AS wau,
        COUNT(*) FILTER (WHERE abu.is_mau)::int AS mau,
        COUNT(*) FILTER (WHERE abu.was_previous_mau AND NOT COALESCE(abu.is_mau, false))::int AS dormant_users,
        ru.slack_user_id AS top_user_id,
        ru.display_name AS top_user_name,
        ru.messages_28d AS top_user_messages
      FROM user_base ub
      LEFT JOIN activity_by_user abu ON abu.user_id = ub.slack_user_id
      LEFT JOIN ranked_users ru ON ru.team = ub.team AND ru.rn = 1
      GROUP BY ub.team, ru.slack_user_id, ru.display_name, ru.messages_28d
      ORDER BY mau DESC, wau DESC, member_count DESC, ub.team;
    `));

    const topUserRows = getRows<{
      user_id: string;
      display_name: string | null;
      team: string;
      messages_7d: number | string;
      active_days_7d: number | string;
      last_seen: string;
    }>(await db.execute(sql`
      WITH params AS (
        SELECT
          ${end}::date AS end_day,
          ${AURA_USER_ID}::text AS aura_user_id,
          ${ADOPTION_TIMEZONE}::text AS adoption_tz
      ),
      active_msgs AS (
        SELECT
          (m.created_at AT TIME ZONE p.adoption_tz)::date AS day,
          m.user_id
        FROM messages m
        CROSS JOIN params p
        WHERE m.role = 'user'
          AND m.user_id != p.aura_user_id
          AND m.created_at >= ((p.end_day - 6)::timestamp AT TIME ZONE p.adoption_tz)
          AND m.created_at < ((p.end_day + 1)::timestamp AT TIME ZONE p.adoption_tz)
          AND (
            m.channel_type = 'dm'
            OR m.content ILIKE ('%<@' || p.aura_user_id || '>%')
          )
      )
      SELECT
        a.user_id,
        u.display_name,
        COALESCE(NULLIF(u.known_facts->>'team', ''), 'Unassigned') AS team,
        COUNT(*)::int AS messages_7d,
        COUNT(DISTINCT a.day)::int AS active_days_7d,
        MAX(a.day)::text AS last_seen
      FROM active_msgs a
      LEFT JOIN users u ON u.slack_user_id = a.user_id
      GROUP BY a.user_id, u.display_name, COALESCE(NULLIF(u.known_facts->>'team', ''), 'Unassigned')
      ORDER BY messages_7d DESC, active_days_7d DESC, display_name
      LIMIT 10;
    `));

    const dormantUserRows = getRows<{
      user_id: string;
      display_name: string | null;
      team: string;
      last_seen: string;
      previous_messages: number | string;
    }>(await db.execute(sql`
      WITH params AS (
        SELECT
          ${end}::date AS end_day,
          ${AURA_USER_ID}::text AS aura_user_id,
          ${ADOPTION_TIMEZONE}::text AS adoption_tz
      ),
      active_msgs AS (
        SELECT
          (m.created_at AT TIME ZONE p.adoption_tz)::date AS day,
          m.user_id
        FROM messages m
        CROSS JOIN params p
        WHERE m.role = 'user'
          AND m.user_id != p.aura_user_id
          AND m.created_at >= ((p.end_day - 55)::timestamp AT TIME ZONE p.adoption_tz)
          AND m.created_at < ((p.end_day + 1)::timestamp AT TIME ZONE p.adoption_tz)
          AND (
            m.channel_type = 'dm'
            OR m.content ILIKE ('%<@' || p.aura_user_id || '>%')
          )
      ),
      activity_by_user AS (
        SELECT
          a.user_id,
          MAX(a.day) AS last_seen,
          COUNT(*) FILTER (WHERE a.day BETWEEN p.end_day - 55 AND p.end_day - 28)::int AS previous_messages,
          BOOL_OR(a.day BETWEEN p.end_day - 27 AND p.end_day) AS is_mau,
          BOOL_OR(a.day BETWEEN p.end_day - 55 AND p.end_day - 28) AS was_previous_mau
        FROM active_msgs a
        CROSS JOIN params p
        GROUP BY a.user_id
      )
      SELECT
        abu.user_id,
        u.display_name,
        COALESCE(NULLIF(u.known_facts->>'team', ''), 'Unassigned') AS team,
        abu.last_seen::text,
        abu.previous_messages
      FROM activity_by_user abu
      LEFT JOIN users u ON u.slack_user_id = abu.user_id
      WHERE abu.was_previous_mau AND NOT COALESCE(abu.is_mau, false)
      ORDER BY abu.previous_messages DESC, abu.last_seen DESC
      LIMIT 25;
    `));

    const depthRows = getRows<{
      active_users_7d: number | string;
      total_messages_7d: number | string;
      p50_messages: number | string | null;
      p90_messages: number | string | null;
      p99_messages: number | string | null;
    }>(await db.execute(sql`
      WITH params AS (
        SELECT
          ${end}::date AS end_day,
          ${AURA_USER_ID}::text AS aura_user_id,
          ${ADOPTION_TIMEZONE}::text AS adoption_tz
      ),
      active_msgs AS (
        SELECT m.user_id
        FROM messages m
        CROSS JOIN params p
        WHERE m.role = 'user'
          AND m.user_id != p.aura_user_id
          AND m.created_at >= ((p.end_day - 6)::timestamp AT TIME ZONE p.adoption_tz)
          AND m.created_at < ((p.end_day + 1)::timestamp AT TIME ZONE p.adoption_tz)
          AND (
            m.channel_type = 'dm'
            OR m.content ILIKE ('%<@' || p.aura_user_id || '>%')
          )
      ),
      per_user AS (
        SELECT user_id, COUNT(*)::int AS message_count
        FROM active_msgs
        GROUP BY user_id
      )
      SELECT
        COUNT(*)::int AS active_users_7d,
        COALESCE(SUM(message_count), 0)::int AS total_messages_7d,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY message_count) AS p50_messages,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY message_count) AS p90_messages,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY message_count) AS p99_messages
      FROM per_user;
    `));

    const histogramRows = getRows<{
      bucket: string;
      sort_order: number | string;
      users: number | string;
    }>(await db.execute(sql`
      WITH params AS (
        SELECT
          ${end}::date AS end_day,
          ${AURA_USER_ID}::text AS aura_user_id,
          ${ADOPTION_TIMEZONE}::text AS adoption_tz
      ),
      buckets AS (
        SELECT * FROM (VALUES
          ('1', 1),
          ('2-5', 2),
          ('6-20', 3),
          ('21-50', 4),
          ('50+', 5)
        ) AS b(bucket, sort_order)
      ),
      active_msgs AS (
        SELECT m.user_id
        FROM messages m
        CROSS JOIN params p
        WHERE m.role = 'user'
          AND m.user_id != p.aura_user_id
          AND m.created_at >= ((p.end_day - 6)::timestamp AT TIME ZONE p.adoption_tz)
          AND m.created_at < ((p.end_day + 1)::timestamp AT TIME ZONE p.adoption_tz)
          AND (
            m.channel_type = 'dm'
            OR m.content ILIKE ('%<@' || p.aura_user_id || '>%')
          )
      ),
      per_user AS (
        SELECT user_id, COUNT(*)::int AS message_count
        FROM active_msgs
        GROUP BY user_id
      ),
      bucketed AS (
        SELECT bucket, COUNT(*)::int AS users
        FROM (
          SELECT
            CASE
              WHEN message_count = 1 THEN '1'
              WHEN message_count BETWEEN 2 AND 5 THEN '2-5'
              WHEN message_count BETWEEN 6 AND 20 THEN '6-20'
              WHEN message_count BETWEEN 21 AND 50 THEN '21-50'
              ELSE '50+'
            END AS bucket
          FROM per_user
        ) counts
        GROUP BY bucket
      )
      SELECT b.bucket, b.sort_order, COALESCE(bucketed.users, 0)::int AS users
      FROM buckets b
      LEFT JOIN bucketed ON bucketed.bucket = b.bucket
      ORDER BY b.sort_order;
    `));

    const summary = {
      workspaceMembers: numberValue(summaryRow?.workspace_members),
      everTalked: numberValue(summaryRow?.ever_talked),
      dau: numberValue(summaryRow?.dau),
      wau: numberValue(summaryRow?.wau),
      mau: numberValue(summaryRow?.mau),
      previousDau: numberValue(summaryRow?.previous_dau),
      previousWau: numberValue(summaryRow?.previous_wau),
      previousMau: numberValue(summaryRow?.previous_mau),
      powerUsers: numberValue(summaryRow?.power_users),
      newUsers7d: numberValue(summaryRow?.new_users_7d),
      newUsers28d: numberValue(summaryRow?.new_users_28d),
      returningMauUsers: numberValue(summaryRow?.returning_mau_users),
      dmMessages28d: numberValue(summaryRow?.dm_messages_28d),
      mentionMessages28d: numberValue(summaryRow?.mention_messages_28d),
      totalMessages7d: numberValue(summaryRow?.total_messages_7d),
      week1EligibleUsers: numberValue(summaryRow?.week1_eligible_users),
      week1ReturnedUsers: numberValue(summaryRow?.week1_returned_users),
    };

    const activity = activityRows.map((row) => ({
      date: row.date,
      isWeekend: row.is_weekend,
      dau: numberValue(row.dau),
      wau: numberValue(row.wau),
      mau: numberValue(row.mau),
      dauMauRatio: numberValue(row.dau_mau_ratio),
      wauMauRatio: numberValue(row.wau_mau_ratio),
    }));

    const funnelCounts = [
      { stage: "Workspace members", count: summary.workspaceMembers },
      { stage: "Ever talked to Aura", count: summary.everTalked },
      { stage: "MAU (28d)", count: summary.mau },
      { stage: "WAU (7d)", count: summary.wau },
      { stage: "DAU", count: summary.dau },
      { stage: "Power users", count: summary.powerUsers },
    ];
    const funnel = funnelCounts.map((step, index) => {
      const previous = index === 0 ? step.count : funnelCounts[index - 1].count;
      return {
        ...step,
        shareOfWorkspace: percentage(step.count, summary.workspaceMembers),
        conversionFromPrevious: index === 0 ? 100 : percentage(step.count, previous),
        dropOffFromPrevious: index === 0 ? 0 : Number((100 - percentage(step.count, previous)).toFixed(1)),
      };
    });

    const cohortMap = new Map<string, {
      cohortWeek: string;
      cohortSize: number;
      retention: Array<{ weekOffset: number; activeUsers: number; retentionPct: number }>;
    }>();
    for (const row of cohortRows) {
      const cohortWeek = row.cohort_week;
      const cohort = cohortMap.get(cohortWeek) ?? {
        cohortWeek,
        cohortSize: numberValue(row.cohort_size),
        retention: [],
      };
      cohort.retention.push({
        weekOffset: numberValue(row.week_offset),
        activeUsers: numberValue(row.active_users),
        retentionPct: numberValue(row.retention_pct),
      });
      cohortMap.set(cohortWeek, cohort);
    }

    const totalConversationMessages28d = summary.dmMessages28d + summary.mentionMessages28d;
    const [depthRow] = depthRows;

    return c.json(
      {
        range: { start, end, timezone: ADOPTION_TIMEZONE },
        activeUserDefinition: {
          auraUserId: AURA_USER_ID,
          includes: ["dm", "mention"],
          excludesAssistantAndBotMessages: true,
        },
        summary: {
          ...summary,
          dauMauRatio: percentage(summary.dau, summary.mau),
          wauMauRatio: percentage(summary.wau, summary.mau),
          reachPct: percentage(summary.everTalked, summary.workspaceMembers),
          returningMauRate: percentage(summary.returningMauUsers, summary.mau),
          week1Retention: percentage(summary.week1ReturnedUsers, summary.week1EligibleUsers),
          dmShare: percentage(summary.dmMessages28d, totalConversationMessages28d),
          mentionShare: percentage(summary.mentionMessages28d, totalConversationMessages28d),
        },
        deltas: {
          dauWow: summary.dau - summary.previousDau,
          wauWow: summary.wau - summary.previousWau,
          mauPreviousPeriod: summary.mau - summary.previousMau,
        },
        activity,
        funnel,
        cohorts: Array.from(cohortMap.values()),
        teams: teamRows.map((row) => ({
          team: row.team,
          memberCount: numberValue(row.member_count),
          dau: numberValue(row.dau),
          wau: numberValue(row.wau),
          mau: numberValue(row.mau),
          mauPct: percentage(numberValue(row.mau), numberValue(row.member_count)),
          dormantUsers: numberValue(row.dormant_users),
          topUser: row.top_user_id && numberValue(row.top_user_messages) > 0
            ? {
              userId: row.top_user_id,
              displayName: row.top_user_name,
              messages28d: numberValue(row.top_user_messages),
            }
            : null,
        })),
        topUsers: topUserRows.map((row) => ({
          userId: row.user_id,
          displayName: row.display_name,
          team: row.team,
          messages7d: numberValue(row.messages_7d),
          activeDays7d: numberValue(row.active_days_7d),
          lastSeen: row.last_seen,
        })),
        dormantUsers: dormantUserRows.map((row) => ({
          userId: row.user_id,
          displayName: row.display_name,
          team: row.team,
          lastSeen: row.last_seen,
          previousMessages: numberValue(row.previous_messages),
        })),
        depth: {
          activeUsers7d: numberValue(depthRow?.active_users_7d),
          totalMessages7d: numberValue(depthRow?.total_messages_7d),
          p50Messages: numberValue(depthRow?.p50_messages),
          p90Messages: numberValue(depthRow?.p90_messages),
          p99Messages: numberValue(depthRow?.p99_messages),
          histogram: histogramRows.map((row) => ({
            bucket: row.bucket,
            users: numberValue(row.users),
          })),
        },
      } as any,
      200,
    );
  } catch (error) {
    logger.error("Failed to fetch adoption data", { error: error instanceof Error ? error.stack : String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});
