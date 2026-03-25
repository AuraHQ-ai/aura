import { describe, it, expect, beforeEach } from "vitest";
import {
  createScratchpadTools,
  getScratchpadContents,
  cleanupScratchpad,
} from "../tools/scratchpad.js";

const execOpts = { toolCallId: "tc", messages: [] as any[], abortSignal: undefined as any };

describe("scratchpad tools", () => {
  const invocationId = "test-invocation-1";

  beforeEach(() => {
    cleanupScratchpad(invocationId);
  });

  it("writes and reads back a section", async () => {
    const { scratchpad_write, scratchpad_read } =
      createScratchpadTools(invocationId);

    const writeResult = await scratchpad_write.execute!(
      { key: "findings", content: "Found 3 bugs" },
      execOpts,
    );
    expect(writeResult).toContain('Written to scratchpad section "findings"');
    expect(writeResult).toContain("findings");

    const readResult = await scratchpad_read.execute!(
      { key: "findings" },
      execOpts,
    );
    expect(readResult).toBe("Found 3 bugs");
  });

  it("overwrites an existing key", async () => {
    const { scratchpad_write, scratchpad_read } =
      createScratchpadTools(invocationId);

    await scratchpad_write.execute!(
      { key: "count", content: "5" },
      execOpts,
    );
    await scratchpad_write.execute!(
      { key: "count", content: "10" },
      execOpts,
    );

    const readResult = await scratchpad_read.execute!({ key: "count" }, execOpts);
    expect(readResult).toBe("10");
  });

  it("reads all sections when no key specified", async () => {
    const { scratchpad_write, scratchpad_read } =
      createScratchpadTools(invocationId);

    await scratchpad_write.execute!(
      { key: "alpha", content: "First section" },
      execOpts,
    );
    await scratchpad_write.execute!(
      { key: "beta", content: "Second section" },
      execOpts,
    );

    const readResult = await scratchpad_read.execute!({}, execOpts);
    expect(readResult).toContain("Scratchpad (2 sections)");
    expect(readResult).toContain("## alpha");
    expect(readResult).toContain("First section");
    expect(readResult).toContain("## beta");
    expect(readResult).toContain("Second section");
  });

  it("returns not-found message for nonexistent key", async () => {
    const { scratchpad_write, scratchpad_read } =
      createScratchpadTools(invocationId);

    await scratchpad_write.execute!(
      { key: "exists", content: "data" },
      execOpts,
    );

    const readResult = await scratchpad_read.execute!(
      { key: "missing" },
      execOpts,
    );
    expect(readResult).toContain('Section "missing" not found');
    expect(readResult).toContain("exists");
  });

  it("returns empty message when scratchpad has no sections", async () => {
    const { scratchpad_read } = createScratchpadTools(invocationId);

    const readResult = await scratchpad_read.execute!({}, execOpts);
    expect(readResult).toBe("Scratchpad is empty.");
  });

  it("cleanup removes all data for an invocation", async () => {
    const { scratchpad_write } = createScratchpadTools(invocationId);

    await scratchpad_write.execute!(
      { key: "data", content: "important" },
      execOpts,
    );

    expect(getScratchpadContents(invocationId)).toEqual({ data: "important" });

    cleanupScratchpad(invocationId);

    expect(getScratchpadContents(invocationId)).toBeNull();
  });

  it("isolates data between invocations", async () => {
    const id1 = "isolation-test-1";
    const id2 = "isolation-test-2";

    const tools1 = createScratchpadTools(id1);
    const tools2 = createScratchpadTools(id2);

    await tools1.scratchpad_write.execute!(
      { key: "shared-key", content: "from invocation 1" },
      execOpts,
    );
    await tools2.scratchpad_write.execute!(
      { key: "shared-key", content: "from invocation 2" },
      execOpts,
    );

    const read1 = await tools1.scratchpad_read.execute!(
      { key: "shared-key" },
      execOpts,
    );
    const read2 = await tools2.scratchpad_read.execute!(
      { key: "shared-key" },
      execOpts,
    );

    expect(read1).toBe("from invocation 1");
    expect(read2).toBe("from invocation 2");

    cleanupScratchpad(id1);
    cleanupScratchpad(id2);
  });

  it("getScratchpadContents returns all entries as a record", async () => {
    const { scratchpad_write } = createScratchpadTools(invocationId);

    await scratchpad_write.execute!(
      { key: "a", content: "1" },
      execOpts,
    );
    await scratchpad_write.execute!(
      { key: "b", content: "2" },
      execOpts,
    );

    const contents = getScratchpadContents(invocationId);
    expect(contents).toEqual({ a: "1", b: "2" });
  });

  it("getScratchpadContents returns null for unknown invocation", () => {
    expect(getScratchpadContents("nonexistent")).toBeNull();
  });
});
