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

describe("run_command timeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sandboxMocks.commandRun.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
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
    expect(sandboxMocks.commandRun).toHaveBeenCalledWith("true", expect.objectContaining({
      timeoutMs: 90_000,
    }));
  });

  it("allows explicit timeouts above 90 seconds up to the 750 second ceiling", async () => {
    const tool = createSandboxTools({ userId: "U123" } as any).run_command as any;

    const input = tool.inputSchema.parse({ command: "sleep 200", timeout_seconds: 200 });
    expect(input.timeout_seconds).toBe(200);

    await tool.execute(input);
    expect(sandboxMocks.commandRun).toHaveBeenCalledWith("sleep 200", expect.objectContaining({
      timeoutMs: 200_000,
    }));
    expect(() =>
      tool.inputSchema.parse({ command: "sleep too long", timeout_seconds: 751 })
    ).toThrow();
  });
});
