import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);

const sandboxMocks = vi.hoisted(() => ({
  commandRun: vi.fn(),
  getOrCreateSandbox: vi.fn(),
  getSandboxEnvs: vi.fn(),
  ensureUserHome: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  insertValues: vi.fn(),
  insertOnConflictDoUpdate: vi.fn(),
  selectRows: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
}));

const toolMocks = vi.hoisted(() => ({
  markTurnSuspendedByDetachedCommand: vi.fn(),
}));

vi.mock("../lib/sandbox.js", () => ({
  getOrCreateSandbox: sandboxMocks.getOrCreateSandbox,
  getSandboxEnvs: sandboxMocks.getSandboxEnvs,
  ensureUserHome: sandboxMocks.ensureUserHome,
  truncateOutput: (value: string) => value,
}));

vi.mock("../lib/logger.js", () => ({
  logger: loggerMocks,
}));

vi.mock("../lib/tool.js", () => ({
  defineTool: (config: any) => config,
  markTurnSuspendedByDetachedCommand: toolMocks.markTurnSuspendedByDetachedCommand,
}));

vi.mock("../db/client.js", () => ({
  db: {
    insert: vi.fn(() => ({
      values: dbMocks.insertValues.mockImplementation(() => ({
        onConflictDoUpdate: dbMocks.insertOnConflictDoUpdate,
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: dbMocks.selectRows,
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: dbMocks.updateSet.mockImplementation(() => ({
        where: dbMocks.updateWhere,
      })),
    })),
  },
}));

import { buildDetachedScript, createSandboxTools } from "./sandbox.js";

function mockCommandLifecycle(options: {
  waitStatus?: "exited" | "not_running" | "timeout";
  inspectStatus?: "running" | "exited" | "not_found";
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  stdoutTail?: string;
  stderrTail?: string;
} = {}) {
  const {
    waitStatus = "exited",
    inspectStatus = "exited",
    exitCode = 0,
    stdout = "",
    stderr = "",
    stdoutTail = "",
    stderrTail = "",
  } = options;

  sandboxMocks.commandRun.mockImplementation(async (command: string, runOptions: any = {}) => {
    if (runOptions.background) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }

    if (command.startsWith("if [ -s ")) {
      return { exitCode: 0, stdout: "4321\n", stderr: "" };
    }

    if (runOptions.envs?.AURA_INLINE_TIMEOUT_SECONDS) {
      return { exitCode: 0, stdout: `${waitStatus}\n`, stderr: "" };
    }

    if (runOptions.envs?.AURA_TAIL_LINES) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          status: inspectStatus,
          exit_code: inspectStatus === "exited" ? exitCode : undefined,
          stdout_tail: stdoutTail,
          stderr_tail: stderrTail,
          runtime_s: 5,
        }),
        stderr: "",
      };
    }

    if (command.includes("read_snippet")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ stdout, stderr }),
        stderr: "",
      };
    }

    return { exitCode: 0, stdout: "", stderr: "" };
  });
}

describe("sandbox command tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCommandLifecycle();
    sandboxMocks.getOrCreateSandbox.mockResolvedValue({
      commands: { run: sandboxMocks.commandRun },
    });
    sandboxMocks.getSandboxEnvs.mockResolvedValue({});
    sandboxMocks.ensureUserHome.mockResolvedValue("/home/user");
    dbMocks.insertValues.mockClear();
    dbMocks.insertOnConflictDoUpdate.mockResolvedValue(undefined);
    dbMocks.selectRows.mockResolvedValue([]);
    dbMocks.updateWhere.mockResolvedValue(undefined);
    process.env.AURA_PUBLIC_URL = "https://aura.test";
    process.env.SANDBOX_WEBHOOK_SECRET = "test-secret";
  });

  it("defaults timeout_seconds to 90 seconds", async () => {
    const tool = createSandboxTools({ userId: "U123" } as any).run_command as any;
    const input = tool.inputSchema.parse({ command: "true" });

    expect(input.timeout_seconds).toBe(90);

    await tool.execute(input);

    expect(sandboxMocks.commandRun).toHaveBeenCalledWith(
      expect.stringContaining("nohup bash -c 'true'"),
      expect.objectContaining({
        cwd: "/home/user",
        background: true,
      }),
    );
    const waitCall = sandboxMocks.commandRun.mock.calls.find(([, options]) =>
      options?.envs?.AURA_INLINE_TIMEOUT_SECONDS
    );
    expect(waitCall?.[1]).toEqual(expect.objectContaining({
      timeoutMs: 92_000,
      envs: expect.objectContaining({ AURA_INLINE_TIMEOUT_SECONDS: "90" }),
    }));
  });

  it("allows explicit timeouts above 90 seconds up to the 750 second ceiling", async () => {
    const tool = createSandboxTools({ userId: "U123" } as any).run_command as any;

    const input = tool.inputSchema.parse({ command: "sleep 200", timeout_seconds: 200 });
    expect(input.timeout_seconds).toBe(200);

    await tool.execute(input);
    const waitCall = sandboxMocks.commandRun.mock.calls.find(([, options]) =>
      options?.envs?.AURA_INLINE_TIMEOUT_SECONDS
    );
    expect(waitCall?.[1]).toEqual(expect.objectContaining({
      timeoutMs: 202_000,
      envs: expect.objectContaining({ AURA_INLINE_TIMEOUT_SECONDS: "200" }),
    }));
    expect(() =>
      tool.inputSchema.parse({ command: "sleep too long", timeout_seconds: 751 })
    ).toThrow();
  });

  it("returns id and pid guidance when inline timeout is exceeded", async () => {
    mockCommandLifecycle({ waitStatus: "timeout", inspectStatus: "running" });
    const tool = createSandboxTools({ userId: "U123" } as any).run_command as any;

    const result = await tool.execute(
      tool.inputSchema.parse({ command: "sleep 300", timeout_seconds: 1 }),
    );

    expect(result.ok).toBe(false);
    expect(result.pid).toBe(4321);
    expect(result.id).toMatch(/^[a-f0-9]{8}$/);
    expect(result.error).toContain("Command exceeded inline timeout (1s)");
    expect(result.error).toContain("still running as PID 4321");
    expect(result.error).toContain("Call check_command({id: '");
  });

  it("starts detached commands and returns id, pid, and started_at", async () => {
    const tool = createSandboxTools({
      userId: "U123",
      channelId: "C123",
      threadTs: "1710000000.000000",
    } as any).run_command_detached as any;

    const result = await tool.execute(
      tool.inputSchema.parse({
        command: "sleep 300",
        workdir: "/home/user/repo",
        env: { FOO: "bar" },
      }),
    );

    expect(result.id).toMatch(/^[a-f0-9]{8}$/);
    expect(result.pid).toBe(4321);
    expect(result.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(sandboxMocks.commandRun).toHaveBeenCalledWith(
      expect.stringContaining("nohup bash -c 'sleep 300'"),
      expect.objectContaining({
        cwd: "/home/user/repo",
        background: true,
        envs: expect.objectContaining({
          FOO: "bar",
          SLACK_USER_ID: "U123",
          AURA_PUBLIC_URL: "https://aura.test",
          SANDBOX_WEBHOOK_SECRET: "test-secret",
        }),
      }),
    );
    expect(dbMocks.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      id: result.id,
      pid: 4321,
      command: "sleep 300",
      status: "running",
      requestedBy: "U123",
      workspaceId: "default",
    }));
    expect(toolMocks.markTurnSuspendedByDetachedCommand).toHaveBeenCalledWith(result.id);
  });

  it("warns once when detached command webhook env vars are missing", async () => {
    vi.resetModules();
    delete process.env.AURA_PUBLIC_URL;
    delete process.env.SANDBOX_WEBHOOK_SECRET;
    const { createSandboxTools: createFreshSandboxTools } = await import("./sandbox.js");
    const tool = createFreshSandboxTools({ userId: "U123" } as any).run_command_detached as any;

    await tool.execute(tool.inputSchema.parse({ command: "sleep 300" }));
    await tool.execute(tool.inputSchema.parse({ command: "sleep 301" }));

    expect(toolMocks.markTurnSuspendedByDetachedCommand).not.toHaveBeenCalled();
    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "run_command_detached: webhook callback disabled, env vars missing",
      {
        missing: ["AURA_PUBLIC_URL", "SANDBOX_WEBHOOK_SECRET"],
        effect:
          "detached commands will run, but completion webhooks will silently no-op; results only available via check_command polling",
      },
    );
  });

  it("does not warn when detached command webhook env vars are present", async () => {
    vi.resetModules();
    const { createSandboxTools: createFreshSandboxTools } = await import("./sandbox.js");
    const tool = createFreshSandboxTools({ userId: "U123" } as any).run_command_detached as any;

    await tool.execute(tool.inputSchema.parse({ command: "sleep 300" }));

    expect(loggerMocks.warn).not.toHaveBeenCalled();
  });

  it("checks detached command status with default tail lines", async () => {
    mockCommandLifecycle({
      inspectStatus: "exited",
      exitCode: 0,
      stdoutTail: "done\n",
      stderrTail: "",
    });
    const tool = createSandboxTools({ userId: "U123" } as any).check_command as any;
    const input = tool.inputSchema.parse({ id: "abcdef12" });

    expect(input.tail_lines).toBe(200);

    const result = await tool.execute(input);

    expect(result).toEqual({
      status: "exited",
      exit_code: 0,
      stdout_tail: "done\n",
      stderr_tail: "",
      runtime_s: 5,
    });
    expect(sandboxMocks.commandRun).toHaveBeenCalledWith(
      expect.stringContaining("tail_lines = max"),
      expect.objectContaining({
        timeoutMs: 2_000,
        envs: expect.objectContaining({
          AURA_COMMAND_ID: "abcdef12",
          AURA_TAIL_LINES: "200",
        }),
      }),
    );
  });
});

describe("detached command wrapper callback", () => {
  it("posts signed completion payload with stdout and stderr tails", async () => {
    const secret = "wrapper-secret";
    const received: Array<{ body: string; signature: string }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        received.push({
          body,
          signature: req.headers["x-webhook-signature"] as string,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("server did not bind to a TCP port");
    }

    const oldPublicUrl = process.env.AURA_PUBLIC_URL;
    process.env.AURA_PUBLIC_URL = `http://127.0.0.1:${address.port}`;
    const script = buildDetachedScript("deadbeef", "printf 'hello'; printf 'warn' >&2", 1);

    try {
      await execFileAsync("bash", ["-c", script], {
        env: {
          ...process.env,
          AURA_PUBLIC_URL: process.env.AURA_PUBLIC_URL,
          SANDBOX_WEBHOOK_SECRET: secret,
        },
        timeout: 10_000,
      });
    } finally {
      process.env.AURA_PUBLIC_URL = oldPublicUrl;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(received).toHaveLength(1);
    const [request] = received;
    const expectedSignature =
      "sha256=" +
      crypto.createHmac("sha256", secret).update(request.body, "utf8").digest("hex");
    expect(request.signature).toBe(expectedSignature);
    expect(JSON.parse(request.body)).toEqual({
      id: "deadbeef",
      exit_code: 0,
      stdout_tail: "hello",
      stderr_tail: "warn",
    });
  });
});
