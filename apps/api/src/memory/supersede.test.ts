import { beforeEach, describe, expect, it, vi } from "vitest";

const txMocks = vi.hoisted(() => {
  const execute = vi.fn(async () => undefined);
  return { execute };
});

vi.mock("../db/client.js", () => ({ db: { execute: vi.fn(), insert: vi.fn() } }));
vi.mock("../db/tx.js", () => ({
  withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) =>
    fn({ execute: txMocks.execute }),
  ),
}));
vi.mock("../lib/embeddings.js", () => ({ embedText: vi.fn(), embedTexts: vi.fn() }));
vi.mock("../lib/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { supersedeMemory } from "./store.js";

function sqlText(call: unknown[]): string {
  const q = call[0] as { queryChunks?: unknown[] };
  return JSON.stringify(q.queryChunks ?? q);
}

describe("supersedeMemory", () => {
  beforeEach(() => txMocks.execute.mockClear());

  it("is a no-op when old and new ids are identical (no self-cycle)", async () => {
    await supersedeMemory("same-id", "same-id");
    expect(txMocks.execute).not.toHaveBeenCalled();
  });

  it("only promotes the replacement if it is still current/disputed", async () => {
    await supersedeMemory("old-id", "new-id");
    expect(txMocks.execute).toHaveBeenCalledTimes(2);
    const second = sqlText(txMocks.execute.mock.calls[1] as unknown[]);
    expect(second).toContain("status IN ('current', 'disputed')");
  });
});
