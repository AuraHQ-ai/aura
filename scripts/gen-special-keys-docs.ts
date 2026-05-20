import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SPECIAL_KEYS, type SpecialKey } from "../apps/api/src/config/registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const outputPath = path.join(
  repoRoot,
  "content/docs/configuration/special-keys.mdx",
);

function escapeTableCell(value: string): string {
  return value
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, "<br />");
}

function escapeMdxText(value: string): string {
  return value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatValue(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "_none_";
  return `\`${escapeTableCell(value)}\``;
}

function formatKey(entry: SpecialKey): string {
  const anchor = entry.docs_anchor ?? entry.key.toLowerCase();
  return `[\`${entry.key}\`](#${anchor})`;
}

function renderTable(entries: readonly SpecialKey[]): string {
  const rows = entries.map((entry) =>
    [
      formatKey(entry),
      entry.kind,
      entry.scope,
      escapeTableCell(entry.effect),
      formatValue(entry.example),
      formatValue(entry.default),
    ].join(" | "),
  );

  return [
    "| Key | Kind | Scope | Effect | Example | Default |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row} |`),
  ].join("\n");
}

function renderDetails(entries: readonly SpecialKey[]): string {
  return entries
    .map((entry) => {
      const anchor = entry.docs_anchor ?? entry.key.toLowerCase();
      return [
        `## ${entry.key}`,
        "",
        `<a id="${anchor}" />`,
        "",
        `- **Kind:** ${entry.kind}`,
        `- **Scope:** ${entry.scope}`,
        `- **Effect:** ${escapeMdxText(entry.effect)}`,
        `- **Example:** ${formatValue(entry.example)}`,
        `- **Default:** ${formatValue(entry.default)}`,
      ].join("\n");
    })
    .join("\n\n");
}

const content = `---
title: "Special configuration keys"
description: "Settings and environment variables with runtime side effects in Aura."
---

# Special configuration keys

This page is generated from \`apps/api/src/config/registry.ts\`. Update the registry, then run \`pnpm gen:special-keys-docs\` to refresh it.

These keys do more than store static configuration: they change runtime behavior, bootstrap sandbox resources, or alter agent capabilities.

${renderTable(SPECIAL_KEYS)}

${renderDetails(SPECIAL_KEYS)}
`;

async function main(): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content);
  console.log(`Generated ${path.relative(repoRoot, outputPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
