import { describe, it, expect } from "vitest";
import { detectScriptOutputError } from "./script-output.js";

describe("detectScriptOutputError", () => {
  it("returns null for clean stdout with no error envelope", () => {
    const output = '{"status": "ok", "count": 42}\nDone processing.';
    expect(detectScriptOutputError(output)).toBeNull();
  });

  it("returns null for empty output", () => {
    expect(detectScriptOutputError("")).toBeNull();
  });

  it('detects {"error": "..."} envelope', () => {
    const output = 'Starting job...\n{"error": "connection refused"}\n';
    const result = detectScriptOutputError(output);
    expect(result).toBe("connection refused");
  });

  it('detects {"error": {...}} envelope with object value', () => {
    const output = '{"error": {"code": 500, "message": "internal"}}';
    const result = detectScriptOutputError(output);
    expect(result).toContain("500");
    expect(result).toContain("internal");
  });

  it('detects {"ok": false} envelope', () => {
    const output = '{"ok": false, "error": "timeout exceeded"}';
    const result = detectScriptOutputError(output);
    expect(result).toBe("timeout exceeded");
  });

  it('detects {"ok": false} without error field', () => {
    const output = '{"ok": false, "data": null}';
    const result = detectScriptOutputError(output);
    expect(result).toBe("Script returned {ok: false}");
  });

  it("ignores ok: true even with error-like fields", () => {
    const output = '{"ok": true, "error": null}';
    expect(detectScriptOutputError(output)).toBeNull();
  });

  it("ignores non-JSON lines", () => {
    const output = "ERROR: something went wrong\nTraceback follows...";
    expect(detectScriptOutputError(output)).toBeNull();
  });

  it("ignores arrays and non-object JSON", () => {
    const output = '[{"error": "inside array"}]\n"just a string"';
    expect(detectScriptOutputError(output)).toBeNull();
  });

  it("picks up the first error line when multiple exist", () => {
    const output = '{"ok": true}\n{"error": "first error"}\n{"error": "second"}';
    expect(detectScriptOutputError(output)).toBe("first error");
  });

  it("ignores malformed JSON that starts with {", () => {
    const output = '{not valid json at all}\n{"status": "ok"}';
    expect(detectScriptOutputError(output)).toBeNull();
  });

  it('does not treat {"error": ""} (empty string) as an error', () => {
    const output = '{"error": ""}';
    expect(detectScriptOutputError(output)).toBeNull();
  });

  it('does not treat {"error": 0} (falsy) as an error', () => {
    const output = '{"error": 0}';
    expect(detectScriptOutputError(output)).toBeNull();
  });
});
