import { describe, expect, it } from "vitest";
import {
  describeChunks,
  isChunkSchemaRejection,
  markdownOnly,
  sanitizeChunk,
  sanitizeChunks,
  slackErrorDetail,
  DEFAULT_TASK_TITLE,
  MAX_BLOCKS_PER_CHUNK,
} from "./slack-chunks.js";

// Fixtures below mirror payloads probed live against chat.appendStream in a
// DM on 2026-08-27 (see issue #1348). "REJECTED" = Slack answered
// invalid_arguments "failed to match exactly one allowed schema [json-pointer:/chunks/0]".

describe("sanitizeChunk — task_update", () => {
  it("passes a minimal valid task_update through unchanged", () => {
    expect(sanitizeChunk({ type: "task_update", id: "call_1", title: "T", status: "in_progress" })).toEqual({
      chunk: { type: "task_update", id: "call_1", title: "T", status: "in_progress" },
    });
  });

  it("REJECTED live: drops null details/output instead of sending them", () => {
    const r = sanitizeChunk({ type: "task_update", id: "r", title: "T", status: "in_progress", details: null, output: null });
    expect(r).toEqual({ chunk: { type: "task_update", id: "r", title: "T", status: "in_progress" } });
  });

  it("REJECTED live: fills the required `text` on sources entries", () => {
    const r = sanitizeChunk({
      type: "task_update", id: "j", title: "T", status: "complete",
      sources: [{ type: "url", url: "https://example.com" }, { url: "https://b.example", text: "B" }, { type: "url" }],
    });
    expect(r).toEqual({
      chunk: {
        type: "task_update", id: "j", title: "T", status: "complete",
        sources: [
          { type: "url", url: "https://example.com", text: "https://example.com" },
          { type: "url", url: "https://b.example", text: "B" },
        ],
      },
    });
  });

  it("REJECTED live: a task_update without an id is dropped with a reason", () => {
    expect(sanitizeChunk({ type: "task_update", title: "T", status: "in_progress" })).toEqual({
      reason: "task_update.id missing",
    });
  });

  it("REJECTED live: maps alias statuses onto the enum and drops unknown ones", () => {
    expect(sanitizeChunk({ type: "task_update", id: "x", title: "T", status: "completed" })).toEqual({
      chunk: { type: "task_update", id: "x", title: "T", status: "complete" },
    });
    expect(sanitizeChunk({ type: "task_update", id: "x", title: "T", status: "failed" })).toEqual({
      chunk: { type: "task_update", id: "x", title: "T", status: "error" },
    });
    expect(sanitizeChunk({ type: "task_update", id: "x", title: "T", status: "bogus" })).toEqual({
      reason: "task_update.status invalid (bogus)",
    });
    expect(sanitizeChunk({ type: "task_update", id: "x", title: "T" })).toEqual({
      reason: "task_update.status invalid (undefined)",
    });
  });

  it("defaults a missing/empty title and omits empty details/output", () => {
    expect(sanitizeChunk({ type: "task_update", id: 7, status: "pending", details: "", output: "" })).toEqual({
      chunk: { type: "task_update", id: "7", title: DEFAULT_TASK_TITLE, status: "pending" },
    });
  });

  it("drops non-string details/output (objects) rather than sending them", () => {
    expect(sanitizeChunk({ type: "task_update", id: "x", title: "T", status: "complete", output: { ok: true }, details: 42 })).toEqual({
      chunk: { type: "task_update", id: "x", title: "T", status: "complete" },
    });
  });

  it("omits an empty sources list", () => {
    expect(sanitizeChunk({ type: "task_update", id: "x", title: "T", status: "complete", sources: [] })).toEqual({
      chunk: { type: "task_update", id: "x", title: "T", status: "complete" },
    });
  });
});

describe("sanitizeChunk — markdown_text / plan_update / blocks", () => {
  it("REJECTED live: markdown_text without text is dropped; empty string is allowed", () => {
    expect(sanitizeChunk({ type: "markdown_text" })).toEqual({ reason: "markdown_text.text is not a string" });
    expect(sanitizeChunk({ type: "markdown_text", text: null })).toEqual({ reason: "markdown_text.text is not a string" });
    expect(sanitizeChunk({ type: "markdown_text", text: "" })).toEqual({ chunk: { type: "markdown_text", text: "" } });
    expect(sanitizeChunk({ type: "markdown_text", text: " " })).toEqual({ chunk: { type: "markdown_text", text: " " } });
  });

  it("strips unknown keys from markdown_text", () => {
    expect(sanitizeChunk({ type: "markdown_text", text: "hi", foo: 1 })).toEqual({ chunk: { type: "markdown_text", text: "hi" } });
  });

  it("plan_update requires a title", () => {
    expect(sanitizeChunk({ type: "plan_update", title: "P" })).toEqual({ chunk: { type: "plan_update", title: "P" } });
    expect(sanitizeChunk({ type: "plan_update" })).toEqual({ reason: "plan_update.title missing" });
  });

  it("blocks chunk passes blocks through untouched (native table/chart delivery)", () => {
    const table = { type: "table", rows: [[{ type: "raw_text", text: "a" }]] };
    expect(sanitizeChunk({ type: "blocks", blocks: [table] })).toEqual({ chunk: { type: "blocks", blocks: [table] } });
  });

  it("blocks chunk drops empty lists and caps at the Slack limit", () => {
    expect(sanitizeChunk({ type: "blocks", blocks: [] })).toEqual({ reason: "blocks.blocks is empty" });
    const many = Array.from({ length: 60 }, (_, i) => ({ type: "divider", i }));
    const r = sanitizeChunk({ type: "blocks", blocks: many });
    expect("chunk" in r && r.chunk.type === "blocks" && r.chunk.blocks.length).toBe(MAX_BLOCKS_PER_CHUNK);
  });

  it("drops unknown types and non-objects", () => {
    expect(sanitizeChunk({ type: "url_source", url: "x" })).toEqual({ reason: "unknown chunk type (url_source)" });
    expect(sanitizeChunk(null)).toEqual({ reason: "not an object" });
    expect(sanitizeChunk("markdown")).toEqual({ reason: "not an object" });
  });
});

describe("sanitizeChunks — batches", () => {
  it("keeps order, drops only the bad element, reports why", () => {
    const { chunks, dropped } = sanitizeChunks([
      { type: "markdown_text", text: "hello" },
      { type: "task_update", title: "no id", status: "in_progress" },
      { type: "task_update", id: "ok", title: "T", status: "complete" },
    ]);
    expect(chunks).toEqual([
      { type: "markdown_text", text: "hello" },
      { type: "task_update", id: "ok", title: "T", status: "complete" },
    ]);
    expect(dropped).toEqual([{ reason: "task_update.id missing", chunk: { type: "task_update", title: "no id", status: "in_progress" } }]);
  });

  it("tolerates undefined / null input", () => {
    expect(sanitizeChunks(undefined)).toEqual({ chunks: [], dropped: [] });
    expect(sanitizeChunks(null)).toEqual({ chunks: [], dropped: [] });
  });
});

describe("markdownOnly", () => {
  it("returns only non-empty markdown_text chunks (the safe retry subset)", () => {
    expect(markdownOnly([
      { type: "task_update", id: "a", title: "T", status: "in_progress" },
      { type: "markdown_text", text: "" },
      { type: "markdown_text", text: "keep me" },
    ])).toEqual([{ type: "markdown_text", text: "keep me" }]);
  });
});

describe("error classification", () => {
  const schemaErr = {
    message: "An API error occurred: invalid_arguments",
    data: { ok: false, error: "invalid_arguments", response_metadata: { messages: ["[ERROR] failed to match exactly one allowed schema [json-pointer:/chunks/0]"] } },
  };

  it("detects a chunk schema rejection via the json-pointer or the error code", () => {
    expect(isChunkSchemaRejection(schemaErr)).toBe(true);
    expect(isChunkSchemaRejection({ data: { error: "invalid_chunks" } })).toBe(true);
    expect(isChunkSchemaRejection({ message: "invalid_arguments" })).toBe(true);
    expect(isChunkSchemaRejection({ data: { error: "message_not_in_streaming_state" } })).toBe(false);
    expect(isChunkSchemaRejection({ data: { error: "channel_type_not_supported" } })).toBe(false);
    expect(isChunkSchemaRejection(new Error("boom"))).toBe(false);
  });

  it("extracts Slack's metadata messages", () => {
    expect(slackErrorDetail(schemaErr)).toBe("[ERROR] failed to match exactly one allowed schema [json-pointer:/chunks/0]");
    expect(slackErrorDetail(new Error("x"))).toBeUndefined();
  });

  it("describeChunks caps output size", () => {
    const s = describeChunks({ text: "x".repeat(2000) }, 100);
    expect(s.length).toBeLessThan(140);
    expect(s).toContain("…(+");
  });
});
