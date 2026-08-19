import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Predicate = ((row: Record<string, unknown>) => boolean) & {
  kind?: string;
};

const dbMock = vi.hoisted(() => {
  const state = {
    rows: [] as Array<Record<string, unknown>>,
    whereCalls: [] as unknown[],
    select: vi.fn(),
    update: vi.fn(),
  };

  function createQuery() {
    let predicate: Predicate | undefined;

    const query: any = {
      from: vi.fn(() => query),
      where: vi.fn((condition: Predicate) => {
        predicate = condition;
        state.whereCalls.push(condition);
        return query;
      }),
      orderBy: vi.fn(() => query),
      limit: vi.fn((limit: number) => {
        const filtered = predicate
          ? state.rows.filter((row) => predicate?.(row))
          : state.rows;

        return Promise.resolve(filtered.slice(0, limit));
      }),
    };

    return query;
  }

  state.select.mockImplementation(() => createQuery());

  state.update.mockImplementation(() => {
    let setArg: Record<string, unknown> = {};
    const query: any = {
      set: vi.fn((arg: Record<string, unknown>) => {
        setArg = arg;
        return query;
      }),
      where: vi.fn((condition: Predicate) => {
        state.rows = state.rows.map((row) =>
          condition(row) ? { ...row, ...setArg } : row,
        );
        return Promise.resolve();
      }),
    };
    return query;
  });

  return state;
});

const schemaMock = vi.hoisted(() => {
  const column = (key: string) => ({ key });

  return {
    jobs: {
      id: column("id"),
      name: column("name"),
      description: column("description"),
      cronSchedule: column("cronSchedule"),
      frequencyConfig: column("frequencyConfig"),
      channelId: column("channelId"),
      executeAt: column("executeAt"),
      requestedBy: column("requestedBy"),
      priority: column("priority"),
      status: column("status"),
      timezone: column("timezone"),
      retries: column("retries"),
      lastExecutedAt: column("lastExecutedAt"),
      executionCount: column("executionCount"),
      playbook: column("playbook"),
      lastResult: column("lastResult"),
      enabled: column("enabled"),
      archivedAt: column("archivedAt"),
      createdAt: column("createdAt"),
    },
    jobExecutions: {
      jobId: column("jobId"),
      startedAt: column("startedAt"),
    },
  };
});

const drizzleMock = vi.hoisted(() => {
  const keyOf = (column: { key: string }) => column.key;
  const predicate = (
    kind: string,
    fn: (row: Record<string, unknown>) => boolean,
  ): Predicate => Object.assign(fn, { kind });

  return {
    eq: vi.fn((column: { key: string }, value: unknown) =>
      predicate("eq", (row) => row[keyOf(column)] === value),
    ),
    ne: vi.fn((column: { key: string }, value: unknown) =>
      predicate("ne", (row) => row[keyOf(column)] !== value),
    ),
    isNotNull: vi.fn((column: { key: string }) =>
      predicate("isNotNull", (row) => row[keyOf(column)] != null),
    ),
    isNull: vi.fn((column: { key: string }) =>
      predicate("isNull", (row) => row[keyOf(column)] == null),
    ),
    and: vi.fn((...conditions: Array<Predicate | undefined>) => {
      const activeConditions = conditions.filter(Boolean) as Predicate[];
      return predicate("and", (row) =>
        activeConditions.every((condition) => condition(row)),
      );
    }),
    or: vi.fn((...conditions: Array<Predicate | undefined>) => {
      const activeConditions = conditions.filter(Boolean) as Predicate[];
      return predicate("or", (row) =>
        activeConditions.some((condition) => condition(row)),
      );
    }),
    desc: vi.fn((column: { key: string }) => ({ column })),
    sql: vi.fn(),
  };
});

const hasRoleMock = vi.hoisted(() => vi.fn());
const resolveSlackUserIdMock = vi.hoisted(() => vi.fn());

vi.mock("../db/client.js", () => ({
  db: {
    select: dbMock.select,
    update: dbMock.update,
  },
}));

vi.mock("@aura/db/schema", () => schemaMock);

vi.mock("drizzle-orm", () => drizzleMock);

vi.mock("../lib/tool.js", () => ({
  defineTool: (config: unknown) => config,
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../lib/permissions.js", () => ({
  hasRole: hasRoleMock,
}));

vi.mock("../lib/resolve-user.js", () => ({
  resolveSlackUserId: resolveSlackUserIdMock,
}));

vi.mock("./slack.js", () => ({
  resolveChannelByName: vi.fn(),
}));

vi.mock("../cron/execute-job.js", () => ({
  executeJob: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

function baseJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    name: "one-shot",
    description: "do the thing",
    cronSchedule: null,
    frequencyConfig: null,
    channelId: null,
    executeAt: new Date("2026-05-20T09:00:00.000Z"),
    requestedBy: "U_REQUESTER",
    priority: "normal",
    status: "pending",
    timezone: "UTC",
    retries: 0,
    lastExecutedAt: null,
    executionCount: 0,
    playbook: null,
    lastResult: null,
    enabled: 1,
    archivedAt: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    ...overrides,
  };
}

async function listJobs(input: Record<string, unknown> = {}) {
  const { createJobTools } = await import("./jobs.js");
  const tool = createJobTools(undefined, { timezone: "UTC" } as any)
    .list_jobs as any;

  return tool.execute(tool.inputSchema.parse(input));
}

describe("list_jobs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T08:00:00.000Z"));
    dbMock.rows = [];
    dbMock.whereCalls = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes enabled recurring jobs with completed status by default", async () => {
    dbMock.rows = [
      baseJob({
        id: "job-recurring",
        name: "sync-meta-comments-daily",
        status: "completed",
        cronSchedule: "0 9 * * *",
        lastExecutedAt: new Date("2026-05-19T09:00:00.000Z"),
        executionCount: 42,
        lastResult: "ok",
      }),
    ];

    const result = await listJobs();

    expect(result.ok).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      name: "sync-meta-comments-daily",
      status: "completed",
      enabled: true,
      is_recurring: true,
      last_executed_at: "2026-05-19T09:00:00+00:00",
      next_run_at: "2026-05-20T09:00:00+00:00",
      execution_count: 42,
      last_result: "ok",
    });
  });

  it("hides disabled recurring jobs by default unless using their status or all", async () => {
    const disabledRecurring = baseJob({
      id: "job-disabled",
      name: "disabled-digest",
      status: "completed",
      enabled: 0,
      cronSchedule: "0 9 * * *",
    });
    dbMock.rows = [disabledRecurring];

    await expect(listJobs()).resolves.toMatchObject({
      ok: true,
      jobs: [],
      count: 0,
    });

    await expect(listJobs({ status: "completed" })).resolves.toMatchObject({
      ok: true,
      jobs: [expect.objectContaining({ name: "disabled-digest" })],
      count: 1,
    });

    await expect(listJobs({ status: "all" })).resolves.toMatchObject({
      ok: true,
      jobs: [expect.objectContaining({ name: "disabled-digest" })],
      count: 1,
    });
  });

  it("computes next_run_at for valid cron schedules and null for invalid ones", async () => {
    dbMock.rows = [
      baseJob({
        id: "job-valid",
        name: "valid-recurring",
        status: "completed",
        cronSchedule: "0 9 * * *",
      }),
      baseJob({
        id: "job-invalid",
        name: "invalid-recurring",
        status: "completed",
        cronSchedule: "not a cron",
      }),
    ];

    const result = await listJobs({ status: "all" });

    expect(result.ok).toBe(true);
    expect(result.jobs).toEqual([
      expect.objectContaining({
        name: "valid-recurring",
        next_run_at: "2026-05-20T09:00:00+00:00",
      }),
      expect.objectContaining({
        name: "invalid-recurring",
        next_run_at: null,
      }),
    ]);
  });

  it("returns every job up to the limit when status is all", async () => {
    dbMock.rows = [
      baseJob({ id: "job-1", name: "pending-job", status: "pending" }),
      baseJob({ id: "job-2", name: "failed-job", status: "failed" }),
      baseJob({ id: "job-3", name: "cancelled-job", status: "cancelled" }),
    ];

    const result = await listJobs({ status: "all", limit: 2 });

    expect(result.ok).toBe(true);
    expect(result.jobs.map((job: { name: string }) => job.name)).toEqual([
      "pending-job",
      "failed-job",
    ]);
    expect(result.count).toBe(2);
    // status:"all" adds no status condition, but the default
    // include_archived:false filter still applies one where() call.
    expect(dbMock.whereCalls).toHaveLength(1);
  });

  it("excludes archived jobs by default and includes them with include_archived", async () => {
    dbMock.rows = [
      baseJob({ id: "job-live", name: "live-job", status: "pending" }),
      baseJob({
        id: "job-archived",
        name: "archived-job",
        status: "cancelled",
        enabled: 0,
        archivedAt: new Date("2026-05-01T00:00:00.000Z"),
      }),
    ];

    await expect(listJobs({ status: "all" })).resolves.toMatchObject({
      ok: true,
      jobs: [expect.objectContaining({ name: "live-job" })],
      count: 1,
    });

    await expect(
      listJobs({ status: "all", include_archived: true }),
    ).resolves.toMatchObject({
      ok: true,
      jobs: [
        expect.objectContaining({ name: "live-job" }),
        expect.objectContaining({ name: "archived-job" }),
      ],
      count: 2,
    });
  });
});

async function updateJob(
  input: Record<string, unknown>,
  context: Record<string, unknown> = {},
) {
  const { createJobTools } = await import("./jobs.js");
  const tool = createJobTools(undefined, { timezone: "UTC", ...context } as any)
    .update_job as any;

  return tool.execute(tool.inputSchema.parse(input));
}

describe("update_job requested_by transfer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T08:00:00.000Z"));
    dbMock.rows = [];
    dbMock.whereCalls = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets the current owner transfer ownership and updates the row to the resolved Slack ID", async () => {
    dbMock.rows = [baseJob()];
    resolveSlackUserIdMock.mockResolvedValue("U_ANNA");

    const result = await updateJob(
      { name: "one-shot", updates: { requested_by: "Anna" } },
      { userId: "U_REQUESTER" },
    );

    expect(result.ok).toBe(true);
    expect(resolveSlackUserIdMock).toHaveBeenCalledWith("Anna");
    expect(dbMock.rows[0].requestedBy).toBe("U_ANNA");
    expect(result.job).toMatchObject({ requestedBy: "U_ANNA" });
  });

  it("rejects a transfer from a non-owner non-admin", async () => {
    dbMock.rows = [baseJob()];
    hasRoleMock.mockResolvedValue(false);
    resolveSlackUserIdMock.mockResolvedValue("U_ANNA");

    const result = await updateJob(
      { name: "one-shot", updates: { requested_by: "Anna" } },
      { userId: "U_SOMEONE_ELSE" },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/owner.*admin/i);
    expect(hasRoleMock).toHaveBeenCalledWith("U_SOMEONE_ELSE", "admin");
    expect(resolveSlackUserIdMock).not.toHaveBeenCalled();
    expect(dbMock.rows[0].requestedBy).toBe("U_REQUESTER");
  });

  it("lets an admin transfer ownership of someone else's job", async () => {
    dbMock.rows = [baseJob()];
    hasRoleMock.mockResolvedValue(true);
    resolveSlackUserIdMock.mockResolvedValue("U_ANNA");

    const result = await updateJob(
      { name: "one-shot", updates: { requested_by: "Anna" } },
      { userId: "U_ADMIN" },
    );

    expect(result.ok).toBe(true);
    expect(hasRoleMock).toHaveBeenCalledWith("U_ADMIN", "admin");
    expect(dbMock.rows[0].requestedBy).toBe("U_ANNA");
  });

  it("returns an error when the new owner cannot be resolved", async () => {
    dbMock.rows = [baseJob()];
    resolveSlackUserIdMock.mockResolvedValue(null);

    const result = await updateJob(
      { name: "one-shot", updates: { requested_by: "Nobody Real" } },
      { userId: "U_REQUESTER" },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Nobody Real");
    expect(dbMock.rows[0].requestedBy).toBe("U_REQUESTER");
  });
});
