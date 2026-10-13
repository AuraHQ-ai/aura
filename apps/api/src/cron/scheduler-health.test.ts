import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrequencyConfig } from "@aura/db/schema";
import { WATCHDOG_RESET_MARKER } from "./job-watchdog.js";
import {
  SCHEDULER_ZERO_SUCCESS_MIN_AFFECTED_JOBS,
  SCHEDULER_ZERO_SUCCESS_MIN_EXPECTED,
  SCHEDULER_ZERO_SUCCESS_SETTING_KEY,
  SCHEDULER_ZERO_SUCCESS_WINDOW_MS,
  classifySchedulerExecution,
  countCronTicksInWindow,
  evaluateSchedulerZeroSuccess,
  formatSchedulerOutageNotice,
  formatSchedulerWindow,
  parseSchedulerIncident,
  type SchedulerExecutionSnapshot,
  type SchedulerJobSnapshot,
} from "./scheduler-health.js";

const dbMock = vi.hoisted(() => {
  const state = {
    results: [] as unknown[][],
    select: vi.fn(),
  };

  function nextResult() {
    return state.results.shift() ?? [];
  }

  function createQuery() {
    const query: any = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      orderBy: vi.fn(() => query),
      groupBy: vi.fn(() => query),
      limit: vi.fn(() => query),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(nextResult()).then(onFulfilled, onRejected),
    };
    return query;
  }

  state.select.mockImplementation(() => createQuery());
  return state;
});

const settingsStore = vi.hoisted(() => ({ data: {} as Record<string, string> }));

const getSettingMock = vi.hoisted(() =>
  vi.fn(async (key: string) => settingsStore.data[key] ?? null),
);
const setSettingMock = vi.hoisted(() =>
  vi.fn(async (key: string, value: string) => {
    settingsStore.data[key] = value;
  }),
);

const sendJobOpsNoticeMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, target: "ops_channel" as const })),
);

vi.mock("../db/client.js", () => ({
  db: { select: dbMock.select },
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../lib/settings.js", () => ({
  getSetting: getSettingMock,
  setSetting: setSettingMock,
  getAllSettings: vi.fn(async () => ({})),
  getConfig: vi.fn(async (_key: string, fallback = "") => fallback),
  getSettingJSON: vi.fn(async (_key: string, fallback: unknown = null) => fallback),
}));

vi.mock("./job-notifications.js", () => ({
  sendJobOpsNotice: sendJobOpsNoticeMock,
}));

function queueDbResults(...results: unknown[][]) {
  dbMock.results = [...results];
}

function baseJob(overrides: Partial<SchedulerJobSnapshot> = {}): SchedulerJobSnapshot {
  return {
    id: "job-1",
    name: "daily-digest",
    requestedBy: "U_OWNER",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    cronSchedule: "0 * * * *",
    frequencyConfig: null,
    timezone: "UTC",
    lastSuccessAt: new Date("2026-09-07T08:00:00.000Z"),
    ...overrides,
  };
}

function exec(overrides: Partial<SchedulerExecutionSnapshot> = {}): SchedulerExecutionSnapshot {
  return {
    jobId: "job-1",
    status: "failed",
    error: "Script hard failure (exit code 127)",
    startedAt: new Date("2026-09-10T00:00:00.000Z"),
    suspendedUntil: null,
    ...overrides,
  };
}

/** Sep 8 00:00 UTC → Sep 14 00:00 UTC — the historical outage window. */
const OUTAGE_START = new Date("2026-09-08T00:00:00.000Z");
const OUTAGE_END = new Date("2026-09-14T00:00:00.000Z");
const OUTAGE_WINDOW_MS = OUTAGE_END.getTime() - OUTAGE_START.getTime();

function sep8to14Jobs(count: number): SchedulerJobSnapshot[] {
  return Array.from({ length: count }, (_, i) =>
    baseJob({
      id: `job-${i + 1}`,
      name: i === 0 ? "daily-digest" : `recurring-job-${i + 1}`,
      requestedBy: "U_OWNER",
      cronSchedule: "0 * * * *",
      lastSuccessAt: new Date("2026-09-07T08:00:00.000Z"),
    }),
  );
}

function sep8to14Executions(jobs: SchedulerJobSnapshot[], perJob: number): SchedulerExecutionSnapshot[] {
  const rows: SchedulerExecutionSnapshot[] = [];
  const classes = [
    { status: "failed", error: "Script hard failure (exit code 127)" },
    { status: "failed", error: "Execution interrupted: recovered by stale detection" },
    { status: "failed", error: `Stale: no completion signal after 59m, ${WATCHDOG_RESET_MARKER}` },
  ] as const;

  for (const job of jobs) {
    for (let i = 0; i < perJob; i++) {
      const klass = classes[i % classes.length];
      rows.push(
        exec({
          jobId: job.id,
          status: klass.status,
          error: klass.error,
          startedAt: new Date(OUTAGE_START.getTime() + i * 60_000),
        }),
      );
    }
  }
  return rows;
}

describe("classifySchedulerExecution", () => {
  it("maps completed / running / failed and disambiguates watchdog errors", () => {
    expect(classifySchedulerExecution("completed", null)).toBe("completed");
    expect(classifySchedulerExecution("running", null)).toBe("running");
    expect(classifySchedulerExecution("failed", "boom")).toBe("failed");
    expect(
      classifySchedulerExecution(
        "failed",
        "Execution interrupted: recovered by stale detection",
      ),
    ).toBe("interrupted");
    expect(
      classifySchedulerExecution("failed", `Stale: no completion signal after 59m, ${WATCHDOG_RESET_MARKER}`),
    ).toBe("stale-killed");
  });
});

describe("countCronTicksInWindow / formatSchedulerWindow", () => {
  it("counts hourly ticks across a 6h production window", () => {
    const end = new Date("2026-09-14T12:00:00.000Z");
    const start = new Date(end.getTime() - SCHEDULER_ZERO_SUCCESS_WINDOW_MS);
    expect(countCronTicksInWindow("0 * * * *", "UTC", start, end)).toBe(6);
  });

  it("returns 0 for a daily cron whose tick is outside a 6h window", () => {
    const now = new Date("2026-09-14T04:00:00.000Z");
    const start = new Date(now.getTime() - SCHEDULER_ZERO_SUCCESS_WINDOW_MS);
    expect(countCronTicksInWindow("0 8 * * *", "UTC", start, now)).toBe(0);
  });

  it("formats the production window as 6h", () => {
    expect(formatSchedulerWindow(SCHEDULER_ZERO_SUCCESS_WINDOW_MS)).toBe("6h");
    expect(formatSchedulerWindow(OUTAGE_WINDOW_MS)).toBe("6d");
  });
});

describe("evaluateSchedulerZeroSuccess", () => {
  it("flags the Sep 8–14 outage shape: many expected fires, zero completed", () => {
    const jobs = sep8to14Jobs(8);
    const executions = sep8to14Executions(jobs, 300); // 8 × 300 = 2,400

    const evaluation = evaluateSchedulerZeroSuccess({
      jobs,
      executions,
      now: OUTAGE_END,
      windowMs: OUTAGE_WINDOW_MS,
    });

    expect(executions).toHaveLength(2400);
    expect(evaluation.completed).toBe(0);
    expect(evaluation.attempted).toBe(2400);
    expect(evaluation.failed).toBeGreaterThan(0);
    expect(evaluation.interrupted).toBeGreaterThan(0);
    expect(evaluation.staleKilled).toBeGreaterThan(0);
    expect(evaluation.expected).toBeGreaterThan(SCHEDULER_ZERO_SUCCESS_MIN_EXPECTED);
    expect(evaluation.affectedJobs.length).toBeGreaterThanOrEqual(
      SCHEDULER_ZERO_SUCCESS_MIN_AFFECTED_JOBS,
    );
    expect(evaluation.isOutage).toBe(true);

    const notice = formatSchedulerOutageNotice(evaluation);
    expect(notice).toContain("Scheduler-wide zero-success window");
    expect(notice).toContain("attempted 2400");
    expect(notice).toContain("completed: 0");
    expect(notice).toContain("interrupted:");
    expect(notice).toContain("stale-killed:");
    expect(notice).toContain("`daily-digest`");
    expect(notice).toContain("last success 2026-09-07T08:00:00.000Z");
  });

  it("does not flag a single rotting job (per-job health's job)", () => {
    const jobs = [baseJob({ cronSchedule: "0 * * * *" })];
    const executions = Array.from({ length: 20 }, (_, i) =>
      exec({ startedAt: new Date(OUTAGE_END.getTime() - i * 60_000) }),
    );

    const evaluation = evaluateSchedulerZeroSuccess({
      jobs,
      executions,
      now: OUTAGE_END,
      windowMs: SCHEDULER_ZERO_SUCCESS_WINDOW_MS,
    });

    expect(evaluation.completed).toBe(0);
    expect(evaluation.attempted).toBe(20);
    expect(evaluation.affectedJobs).toHaveLength(1);
    expect(evaluation.isOutage).toBe(false);
  });

  it("does not flag low-volume / newly-created jobs under the sample guard", () => {
    const now = new Date("2026-09-14T04:00:00.000Z");
    const newJobs = [
      baseJob({
        id: "new-1",
        name: "brand-new-hourly",
        createdAt: new Date(now.getTime() - 10 * 60 * 1000),
        cronSchedule: "0 * * * *",
        lastSuccessAt: null,
      }),
      baseJob({
        id: "new-2",
        name: "also-new",
        createdAt: new Date(now.getTime() - 5 * 60 * 1000),
        cronSchedule: "0 * * * *",
        lastSuccessAt: null,
      }),
    ];

    const lowVolume = evaluateSchedulerZeroSuccess({
      jobs: newJobs,
      executions: [],
      now,
    });

    expect(lowVolume.expected).toBe(0);
    expect(lowVolume.attempted).toBe(0);
    expect(lowVolume.isOutage).toBe(false);

    const dailyJobs = [
      baseJob({
        id: "daily-1",
        name: "morning-a",
        cronSchedule: "0 8 * * *",
        lastSuccessAt: new Date("2026-09-13T08:00:00.000Z"),
      }),
      baseJob({
        id: "daily-2",
        name: "morning-b",
        cronSchedule: "0 8 * * *",
        lastSuccessAt: new Date("2026-09-13T08:00:00.000Z"),
      }),
    ];
    const quietMorning = evaluateSchedulerZeroSuccess({
      jobs: dailyJobs,
      executions: [],
      now, // 04:00 UTC — 08:00 tick is still ahead
    });
    expect(quietMorning.expected).toBe(0);
    expect(quietMorning.isOutage).toBe(false);
  });

  it("does not flag when any in-window execution completed", () => {
    const jobs = sep8to14Jobs(4);
    const executions = [
      ...sep8to14Executions(jobs.slice(0, 3), 10),
      exec({
        jobId: jobs[3].id,
        status: "completed",
        error: null,
        startedAt: new Date("2026-09-13T23:00:00.000Z"),
      }),
    ];

    const evaluation = evaluateSchedulerZeroSuccess({
      jobs,
      executions,
      now: OUTAGE_END,
      windowMs: OUTAGE_WINDOW_MS,
    });

    expect(evaluation.completed).toBe(1);
    expect(evaluation.isOutage).toBe(false);
  });

  it("ignores currently webhook-suspended executions", () => {
    const now = new Date("2026-09-14T12:00:00.000Z");
    const jobs = [
      baseJob({ id: "job-1", name: "parked-a", cronSchedule: "0 * * * *" }),
      baseJob({ id: "job-2", name: "parked-b", cronSchedule: "0 * * * *" }),
    ];
    const executions = [
      exec({
        jobId: "job-1",
        status: "running",
        error: null,
        suspendedUntil: new Date(now.getTime() + 30 * 60 * 1000),
      }),
      exec({
        jobId: "job-2",
        status: "running",
        error: null,
        suspendedUntil: new Date(now.getTime() + 30 * 60 * 1000),
      }),
    ];

    const evaluation = evaluateSchedulerZeroSuccess({ jobs, executions, now });
    expect(evaluation.attempted).toBe(0);
    // Expected ticks still count (jobs existed before the window) — but
    // parked webhook work must not inflate attempted/failed.
    expect(evaluation.failed).toBe(0);
  });
});

describe("parseSchedulerIncident", () => {
  it("rejects missing or malformed payloads", () => {
    expect(parseSchedulerIncident(null)).toBeNull();
    expect(parseSchedulerIncident("not-json")).toBeNull();
    expect(parseSchedulerIncident(JSON.stringify({ open: true }))).toBeNull();
  });
});

describe("scanSchedulerZeroSuccess", () => {
  beforeEach(() => {
    dbMock.results = [];
    settingsStore.data = {};
    vi.clearAllMocks();
    sendJobOpsNoticeMock.mockResolvedValue({ ok: true, target: "ops_channel" });
    getSettingMock.mockImplementation(async (key: string) => settingsStore.data[key] ?? null);
    setSettingMock.mockImplementation(async (key: string, value: string) => {
      settingsStore.data[key] = value;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Executions dated inside the production 6h lookback ending at `now`. */
  function outageDbRows(now: Date) {
    const snapshots = sep8to14Jobs(8);
    const jobs = snapshots.map(({ lastSuccessAt: _, ...row }) => row);
    const windowStart = new Date(now.getTime() - SCHEDULER_ZERO_SUCCESS_WINDOW_MS);
    const classes = [
      { status: "failed", error: "Script hard failure (exit code 127)" },
      { status: "failed", error: "Execution interrupted: recovered by stale detection" },
      { status: "failed", error: `Stale: no completion signal after 59m, ${WATCHDOG_RESET_MARKER}` },
    ] as const;
    const executions = snapshots.flatMap((job) =>
      Array.from({ length: 30 }, (_, i) =>
        exec({
          jobId: job.id,
          status: classes[i % classes.length].status,
          error: classes[i % classes.length].error,
          startedAt: new Date(windowStart.getTime() + i * 60_000),
        }),
      ),
    );
    const lastSuccess = snapshots.map((job) => ({
      jobId: job.id,
      lastSuccessAt: job.lastSuccessAt,
    }));
    return { jobs, executions, lastSuccess };
  }

  it("sends exactly one alert for the Sep 8–14 outage shape", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(OUTAGE_END);
    const { jobs, executions, lastSuccess } = outageDbRows(OUTAGE_END);
    queueDbResults(jobs, executions, lastSuccess);

    const { scanSchedulerZeroSuccess } = await import("./scheduler-health.js");
    const result = await scanSchedulerZeroSuccess(OUTAGE_END);

    expect(result.alerted).toBe(1);
    expect(result.recovered).toBe(0);
    expect(sendJobOpsNoticeMock).toHaveBeenCalledTimes(1);
    expect(sendJobOpsNoticeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "recurring-job-scheduler",
        text: expect.stringContaining("Scheduler-wide zero-success window"),
        logContext: expect.objectContaining({ event: "scheduler_zero_success_alert" }),
      }),
    );
    expect(sendJobOpsNoticeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(`attempted ${executions.length}`),
      }),
    );
    expect(sendJobOpsNoticeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringMatching(/completed: 0/),
      }),
    );
    expect(sendJobOpsNoticeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("`daily-digest`"),
      }),
    );

    const stored = parseSchedulerIncident(settingsStore.data[SCHEDULER_ZERO_SUCCESS_SETTING_KEY]);
    expect(stored).toMatchObject({ open: true });
    vi.useRealTimers();
  });

  it("does not re-alert while the incident is still open (suppression)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(OUTAGE_END);
    const { jobs, executions, lastSuccess } = outageDbRows(OUTAGE_END);

    queueDbResults(jobs, executions, lastSuccess);
    const { scanSchedulerZeroSuccess } = await import("./scheduler-health.js");
    await scanSchedulerZeroSuccess(OUTAGE_END);
    expect(sendJobOpsNoticeMock).toHaveBeenCalledTimes(1);

    sendJobOpsNoticeMock.mockClear();
    queueDbResults(jobs, executions, lastSuccess);
    const second = await scanSchedulerZeroSuccess(OUTAGE_END);

    expect(second.alerted).toBe(0);
    expect(second.recovered).toBe(0);
    expect(sendJobOpsNoticeMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("sends a recovery notice that clears the incident and allows a later outage alert", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(OUTAGE_END);
    const { jobs, executions, lastSuccess } = outageDbRows(OUTAGE_END);
    const { scanSchedulerZeroSuccess } = await import("./scheduler-health.js");

    queueDbResults(jobs, executions, lastSuccess);
    await scanSchedulerZeroSuccess(OUTAGE_END);
    expect(parseSchedulerIncident(settingsStore.data[SCHEDULER_ZERO_SUCCESS_SETTING_KEY])?.open).toBe(
      true,
    );

    sendJobOpsNoticeMock.mockClear();
    const recoveredExecutions = [
      exec({
        jobId: jobs[0].id,
        status: "completed",
        error: null,
        startedAt: new Date(OUTAGE_END.getTime() - 60_000),
      }),
    ];
    const recoveredLastSuccess = [{ jobId: jobs[0].id, lastSuccessAt: OUTAGE_END }];
    queueDbResults(jobs, recoveredExecutions, recoveredLastSuccess);

    const recovered = await scanSchedulerZeroSuccess(OUTAGE_END);
    expect(recovered.alerted).toBe(0);
    expect(recovered.recovered).toBe(1);
    expect(sendJobOpsNoticeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Scheduler recovered"),
        logContext: expect.objectContaining({ event: "scheduler_zero_success_recovery" }),
      }),
    );
    expect(parseSchedulerIncident(settingsStore.data[SCHEDULER_ZERO_SUCCESS_SETTING_KEY])?.open).toBe(
      false,
    );

    sendJobOpsNoticeMock.mockClear();
    queueDbResults(jobs, executions, lastSuccess);
    const laterOutage = await scanSchedulerZeroSuccess(OUTAGE_END);
    expect(laterOutage.alerted).toBe(1);
    expect(sendJobOpsNoticeMock).toHaveBeenCalledTimes(1);
    expect(parseSchedulerIncident(settingsStore.data[SCHEDULER_ZERO_SUCCESS_SETTING_KEY])?.open).toBe(
      true,
    );
    vi.useRealTimers();
  });

  it("does not alert for low-volume / newly-created jobs", async () => {
    const now = new Date("2026-09-14T04:00:00.000Z");
    queueDbResults(
      [
        {
          id: "new-1",
          name: "brand-new",
          requestedBy: "U_OWNER",
          createdAt: new Date(now.getTime() - 10 * 60 * 1000),
          cronSchedule: "0 * * * *",
          frequencyConfig: { minIntervalHours: 24 } satisfies FrequencyConfig,
          timezone: "UTC",
        },
      ],
      [], // no executions
      [], // no last success
    );

    const { scanSchedulerZeroSuccess } = await import("./scheduler-health.js");
    const result = await scanSchedulerZeroSuccess(now);

    expect(result.alerted).toBe(0);
    expect(sendJobOpsNoticeMock).not.toHaveBeenCalled();
    expect(setSettingMock).not.toHaveBeenCalled();
  });

  it("never throws when the DB query fails (heartbeat isolation)", async () => {
    dbMock.select.mockImplementationOnce(() => {
      throw new Error("db unavailable");
    });

    const { scanSchedulerZeroSuccess } = await import("./scheduler-health.js");
    await expect(scanSchedulerZeroSuccess(OUTAGE_END)).resolves.toEqual({
      scanned: 0,
      alerted: 0,
      recovered: 0,
    });
    expect(sendJobOpsNoticeMock).not.toHaveBeenCalled();
  });
});
