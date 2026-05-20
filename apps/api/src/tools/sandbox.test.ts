import { beforeEach, describe, expect, it, vi } from "vitest";

const sandboxMocks = vi.hoisted(() => ({
  commandRun: vi.fn(),
  getOrCreateSandbox: vi.fn(),
  getSandboxEnvs: vi.fn(),
  ensureUserHome: vi.fn(),
}));

vi.mock("../lib/sandbox.js", () => ({
  getOrCreateSandbox: sandboxMocks.getOrCreateSandbox,
  getSandboxEnvs: sandboxMocks.getSandboxEnvs,
  ensureUserHome: sandboxMocks.ensureUserHome,
  truncateOutput: (value: string) => value,
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../lib/tool.js", () => ({
  defineTool: (config: any) => config,
}));

import { createSandboxTools } from "./sandbox.js";

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
    const tool = createSandboxTools({ userId: "U123" } as any).run_command_detached as any;

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
        envs: expect.objectContaining({ FOO: "bar", SLACK_USER_ID: "U123" }),
      }),
    );
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
