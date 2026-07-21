import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const dbMock = vi.hoisted(() => {
  type Operation = {
    kind: "select" | "update" | "insert" | "delete";
    table?: unknown;
    setArg?: Record<string, unknown>;
    whereArg?: unknown;
  };

  const state = {
    selectResults: [] as unknown[][],
    operations: [] as Operation[],
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  };

  function createQuery(operation: Operation, result: () => unknown[]) {
    const query: any = {
      from: vi.fn(() => query),
      where: vi.fn((whereArg: unknown) => {
        operation.whereArg = whereArg;
        return query;
      }),
      orderBy: vi.fn(() => query),
      limit: vi.fn(() => query),
      set: vi.fn((setArg: Record<string, unknown>) => {
        operation.setArg = setArg;
        return query;
      }),
      values: vi.fn(() => query),
      onConflictDoUpdate: vi.fn(() => query),
      returning: vi.fn(() => {
        state.operations.push(operation);
        return Promise.resolve(result());
      }),
      then: (onFulfilled: any, onRejected: any) => {
        state.operations.push(operation);
        return Promise.resolve(result()).then(onFulfilled, onRejected);
      },
    };
    return query;
  }

  state.select.mockImplementation(() =>
    createQuery({ kind: "select" }, () => state.selectResults.shift() ?? []),
  );
  state.update.mockImplementation((table: unknown) =>
    createQuery({ kind: "update", table }, () => []),
  );
  // Audit-log inserts (defineTool) get a stable id so the wrapper is happy.
  state.insert.mockImplementation((table: unknown) =>
    createQuery({ kind: "insert", table }, () => [{ id: "audit-log-1" }]),
  );
  state.delete.mockImplementation((table: unknown) =>
    createQuery({ kind: "delete", table }, () => []),
  );

  return state;
});

vi.mock("../db/client.js", () => ({
  db: {
    select: dbMock.select,
    update: dbMock.update,
    insert: dbMock.insert,
    delete: dbMock.delete,
  },
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("./slack.js", () => ({
  resolveChannelByName: vi.fn(),
}));

vi.mock("../cron/execute-job.js", () => ({
  executeJob: vi.fn(),
  MAX_RETRIES: 3,
}));

vi.mock("../lib/permissions.js", () => ({
  hasRole: vi.fn(async () => false),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

import { createJobTools } from "./jobs.js";
import { jobs } from "@aura/db/schema";

const dialect = new PgDialect();

function whereSql(operation: { whereArg?: unknown }): string {
  return dialect.sqlToQuery(operation.whereArg as SQL).sql;
}

function selectOps() {
  return dbMock.operations.filter((op) => op.kind === "select");
}

function jobsUpdateSets() {
  return dbMock.operations
    .filter((op) => op.kind === "update" && op.table === jobs)
    .map((op) => op.setArg ?? {});
}

function baseJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId: "default",
    name: "test-job",
    description: "do the thing",
    playbook: null,
    script: null,
    cronSchedule: null,
    notifyOnSuccess: false,
    frequencyConfig: null,
    channelId: null,
    threadTs: null,
    executeAt: null,
    requestedBy: "U_REQUESTER",
    priority: "normal",
    status: "pending",
    timezone: "UTC",
    result: null,
    retries: 0,
    lastExecutedAt: null,
    lastResult: null,
    executionCount: 0,
    todayExecutions: 0,
    lastExecutionDate: null,
    enabled: 1,
    archivedAt: null,
    requiredCredentialIds: [],
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  dbMock.selectResults = [];
  dbMock.operations = [];
  vi.clearAllMocks();
});

describe("list_jobs archived filtering", () => {
  it("excludes archived jobs by default", async () => {
    dbMock.selectResults = [[]];
    const tools = createJobTools();

    const result = await (tools.list_jobs as any).execute({
      status: "pending",
      recurring_only: false,
      include_archived: false,
      limit: 20,
    });

    expect(result.ok).toBe(true);
    const [listSelect] = selectOps();
    expect(whereSql(listSelect)).toContain('"archived_at" is null');
  });

  it("includes archived jobs when include_archived is true", async () => {
    const archivedJob = baseJob({
      name: "retired-digest",
      cronSchedule: "0 9 * * *",
      enabled: 0,
      archivedAt: new Date("2026-07-10T00:00:00.000Z"),
    });
    dbMock.selectResults = [[archivedJob]];
    const tools = createJobTools();

    const result = await (tools.list_jobs as any).execute({
      status: "pending",
      recurring_only: false,
      include_archived: true,
      limit: 20,
    });

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.jobs[0].name).toBe("retired-digest");
    const [listSelect] = selectOps();
    expect(whereSql(listSelect)).not.toContain("archived_at");
  });
});

describe("cancel_job archive option", () => {
  it("archives a recurring job: sets archivedAt and enabled 0", async () => {
    const recurringJob = baseJob({
      name: "old-monitor",
      cronSchedule: "0 9 * * 1-5",
      enabled: 0,
    });
    dbMock.selectResults = [[recurringJob]];
    const tools = createJobTools();

    const result = await (tools.cancel_job as any).execute({
      name: "old-monitor",
      archive: true,
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("archived");
    const [set] = jobsUpdateSets();
    expect(set.enabled).toBe(0);
    expect(set.archivedAt).toBeInstanceOf(Date);
    expect(set.updatedAt).toBeInstanceOf(Date);
  });

  it("keeps plain disable behavior when archive is false", async () => {
    const recurringJob = baseJob({
      name: "keep-around",
      cronSchedule: "0 9 * * *",
    });
    dbMock.selectResults = [[recurringJob]];
    const tools = createJobTools();

    const result = await (tools.cancel_job as any).execute({
      name: "keep-around",
      archive: false,
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("disabled");
    const [set] = jobsUpdateSets();
    expect(set.enabled).toBe(0);
    expect(set).not.toHaveProperty("archivedAt");
  });

  it("stamps archivedAt when archiving a pending one-shot", async () => {
    const oneShot = baseJob({
      name: "one-shot-reminder",
      executeAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    dbMock.selectResults = [[oneShot]];
    const tools = createJobTools();

    const result = await (tools.cancel_job as any).execute({
      name: "one-shot-reminder",
      archive: true,
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("archived");
    const [set] = jobsUpdateSets();
    expect(set.status).toBe("cancelled");
    expect(set.archivedAt).toBeInstanceOf(Date);
  });
});

describe("update_job un-archive on re-enable", () => {
  it("clears archivedAt when re-enabling an archived job", async () => {
    const archivedJob = baseJob({
      name: "retired-digest",
      cronSchedule: "0 9 * * *",
      enabled: 0,
      archivedAt: new Date("2026-07-10T00:00:00.000Z"),
    });
    const reEnabledJob = baseJob({
      name: "retired-digest",
      cronSchedule: "0 9 * * *",
      enabled: 1,
      archivedAt: null,
      executeAt: new Date("2026-07-22T09:00:00.000Z"),
    });
    dbMock.selectResults = [[archivedJob], [reEnabledJob]];
    const tools = createJobTools();

    const result = await (tools.update_job as any).execute({
      name: "retired-digest",
      updates: { enabled: true },
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("un-archived");
    const [set] = jobsUpdateSets();
    expect(set.archivedAt).toBeNull();
    expect(set.enabled).toBe(1);
    expect(set.status).toBe("pending");
  });

  it("does not mention un-archiving for a non-archived job", async () => {
    const disabledJob = baseJob({
      name: "just-disabled",
      cronSchedule: "0 9 * * *",
      enabled: 0,
      archivedAt: null,
    });
    const reEnabledJob = baseJob({
      name: "just-disabled",
      cronSchedule: "0 9 * * *",
      enabled: 1,
    });
    dbMock.selectResults = [[disabledJob], [reEnabledJob]];
    const tools = createJobTools();

    const result = await (tools.update_job as any).execute({
      name: "just-disabled",
      updates: { enabled: true },
    });

    expect(result.ok).toBe(true);
    expect(result.message).not.toContain("un-archived");
    const [set] = jobsUpdateSets();
    expect(set).not.toHaveProperty("archivedAt");
    expect(set.enabled).toBe(1);
  });
});
