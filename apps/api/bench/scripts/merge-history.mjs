import { existsSync, readFileSync, writeFileSync } from "node:fs";

const currentPath = "apps/api/bench/history.jsonl";
const localPath = process.env.LOCAL_HISTORY;

function splitLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function lineKey(line) {
  try {
    const entry = JSON.parse(line);
    return entry && entry.runId ? `run:${entry.runId}` : `line:${line}`;
  } catch {
    return `line:${line}`;
  }
}

const currentLines = existsSync(currentPath)
  ? splitLines(readFileSync(currentPath, "utf8"))
  : [];
const localLines = localPath && existsSync(localPath)
  ? splitLines(readFileSync(localPath, "utf8"))
  : [];

const seen = new Set(currentLines.map(lineKey));
const merged = [...currentLines];

for (const line of localLines) {
  const key = lineKey(line);
  if (!seen.has(key)) {
    seen.add(key);
    merged.push(line);
  }
}

writeFileSync(currentPath, merged.length ? `${merged.join("\n")}\n` : "");
