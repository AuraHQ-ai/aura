import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { writeFile } from "fs/promises";
import { eq, sql } from "drizzle-orm";
import { entities } from "@aura/db/schema";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const isProd = process.argv.includes("--prod");
const envFile = isProd ? ".env.production" : ".env.local";
config({ path: resolve(repoRoot, envFile) });
if (isProd) console.log("Using .env.production (--prod)");

const { db } = await import("../db/client.js");

type PronounClass = "feminine" | "masculine" | "neutral" | "ambiguous";
type ExpectedClass = Exclude<PronounClass, "ambiguous">;
type AuditStatus = "ok" | "mismatch" | "ambiguous" | "no_gender";

type PronounCounts = {
  feminine: number;
  masculine: number;
  neutral: number;
};

type RawAuditRow = {
  entity_id: string;
  canonical_name: string;
  slack_user_id: string | null;
  users_gender: string | null;
  summary: string;
};

type AuditRecord = {
  entityId: string;
  canonicalName: string;
  slackUserId: string | null;
  usersGender: string | null;
  summary: string;
  summaryPreview: string;
  counts: PronounCounts;
  detectedClass: PronounClass;
  expectedClass: ExpectedClass | null;
  status: AuditStatus;
};

type PostPatchVerification = {
  entityId: string;
  canonicalName: string;
  usersGender: string | null;
  beforeDetectedClass: PronounClass;
  afterDetectedClass: PronounClass;
  beforeStatus: AuditStatus;
  afterStatus: AuditStatus;
};

const FEMININE_REGEX = /\b(she|her|hers|herself)\b/gi;
const MASCULINE_REGEX = /\b(he|him|his|himself)\b/gi;
const NEUTRAL_REGEX = /\b(they|them|their|theirs|themself|themselves)\b/gi;
const JOAN_ENTITY_ID = "f212a72d-a781-4af6-990b-2a908bf3c1e6";

const OBJECT_CONTEXT_WORDS = new Set([
  "to",
  "with",
  "for",
  "by",
  "from",
  "about",
  "tell",
  "told",
  "asked",
  "thanked",
  "help",
  "helped",
  "met",
  "saw",
  "join",
  "joined",
  "invite",
  "invited",
  "of",
]);

function parseOnlyEntityId(): string | null {
  const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
  if (!onlyArg) return null;
  const id = onlyArg.slice("--only=".length).trim();
  return id.length > 0 ? id : null;
}

function nowStamp(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function csvEscape(value: string | number | null | undefined): string {
  const asString = value == null ? "" : String(value);
  return `"${asString.replace(/"/g, "\"\"")}"`;
}

function toCsvRow(values: Array<string | number | null | undefined>): string {
  return values.map((value) => csvEscape(value)).join(",");
}

function countMatches(regex: RegExp, text: string): number {
  return text.match(regex)?.length ?? 0;
}

function detectPronounCounts(summary: string): PronounCounts {
  return {
    feminine: countMatches(FEMININE_REGEX, summary),
    masculine: countMatches(MASCULINE_REGEX, summary),
    neutral: countMatches(NEUTRAL_REGEX, summary),
  };
}

function deriveDetectedClass(counts: PronounCounts): PronounClass {
  const maxCount = Math.max(counts.feminine, counts.masculine, counts.neutral);
  if (maxCount === 0) return "ambiguous";

  const winners: Array<Exclude<PronounClass, "ambiguous">> = [];
  if (counts.feminine === maxCount) winners.push("feminine");
  if (counts.masculine === maxCount) winners.push("masculine");
  if (counts.neutral === maxCount) winners.push("neutral");

  if (winners.length !== 1) return "ambiguous";
  return winners[0];
}

function normalizeExpectedClass(gender: string | null): ExpectedClass | null {
  if (!gender) return null;
  const normalized = gender.trim().toLowerCase();
  if (normalized === "male") return "masculine";
  if (normalized === "female") return "feminine";
  if (normalized === "non-binary" || normalized === "nonbinary" || normalized === "other") {
    return "neutral";
  }
  return null;
}

function determineStatus(
  expectedClass: ExpectedClass | null,
  detectedClass: PronounClass,
): AuditStatus {
  if (!expectedClass) return "no_gender";
  if (detectedClass === "ambiguous") return "ambiguous";
  if (expectedClass === detectedClass) return "ok";

  // Neutral <-> gendered substitutions are intentionally not automated.
  if (expectedClass === "neutral" || detectedClass === "neutral") return "ambiguous";
  return "mismatch";
}

function summarizeCounts(counts: PronounCounts): string {
  return `feminine=${counts.feminine};masculine=${counts.masculine};neutral=${counts.neutral}`;
}

function toPreview(summary: string): string {
  return summary.replace(/\s+/g, " ").trim().slice(0, 120);
}

function titleCase(word: string): string {
  if (word.length === 0) return word;
  return `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`;
}

function preserveCase(source: string, replacement: string): string {
  if (source.toUpperCase() === source) return replacement.toUpperCase();
  if (titleCase(source) === source) return titleCase(replacement);
  return replacement.toLowerCase();
}

function replaceWithContext(
  source: string,
  regex: RegExp,
  replacer: (match: string, index: number, text: string) => string,
): string {
  const parts: string[] = [];
  let lastIndex = 0;
  regex.lastIndex = 0;

  let match: RegExpExecArray | null = regex.exec(source);
  while (match) {
    const index = match.index;
    parts.push(source.slice(lastIndex, index));
    parts.push(replacer(match[0], index, source));
    lastIndex = index + match[0].length;
    if (match[0].length === 0) regex.lastIndex++;
    match = regex.exec(source);
  }

  parts.push(source.slice(lastIndex));
  return parts.join("");
}

function previousWord(text: string, index: number): string | null {
  const before = text.slice(0, index);
  const match = before.match(/([A-Za-z]+)\s*$/);
  return match?.[1]?.toLowerCase() ?? null;
}

function hasFollowingWord(text: string, indexAfterMatch: number): boolean {
  return /^\s+[A-Za-z][A-Za-z'-]*/.test(text.slice(indexAfterMatch));
}

function hasFollowingPunctuation(text: string, indexAfterMatch: number): boolean {
  return /^\s*[,.;:!?]/.test(text.slice(indexAfterMatch));
}

export function replaceFemToMasc(summary: string): string {
  let next = summary;
  next = next.replace(/\bshe\b/gi, (match) => preserveCase(match, "he"));

  next = replaceWithContext(next, /\bher\b/gi, (match, index, text) => {
    const endIndex = index + match.length;
    if (hasFollowingWord(text, endIndex) || hasFollowingPunctuation(text, endIndex)) {
      return preserveCase(match, "his");
    }

    const prev = previousWord(text, index);
    if (prev && OBJECT_CONTEXT_WORDS.has(prev)) {
      return preserveCase(match, "him");
    }

    return preserveCase(match, "his");
  });

  next = next.replace(/\bhers\b/gi, (match) => preserveCase(match, "his"));
  next = next.replace(/\bherself\b/gi, (match) => preserveCase(match, "himself"));
  return next;
}

export function replaceMascToFem(summary: string): string {
  let next = summary;
  next = next.replace(/\bhe\b/gi, (match) => preserveCase(match, "she"));
  next = next.replace(/\bhim\b/gi, (match) => preserveCase(match, "her"));

  next = replaceWithContext(next, /\bhis\b/gi, (match, index, text) => {
    const endIndex = index + match.length;
    const replacement = hasFollowingWord(text, endIndex) ? "her" : "hers";
    return preserveCase(match, replacement);
  });

  next = next.replace(/\bhimself\b/gi, (match) => preserveCase(match, "herself"));
  return next;
}

function toAuditRecord(row: RawAuditRow): AuditRecord {
  const counts = detectPronounCounts(row.summary);
  const detectedClass = deriveDetectedClass(counts);
  const expectedClass = normalizeExpectedClass(row.users_gender);
  const status = determineStatus(expectedClass, detectedClass);

  return {
    entityId: row.entity_id,
    canonicalName: row.canonical_name,
    slackUserId: row.slack_user_id,
    usersGender: row.users_gender,
    summary: row.summary,
    summaryPreview: toPreview(row.summary),
    counts,
    detectedClass,
    expectedClass,
    status,
  };
}

async function fetchRows(onlyEntityId: string | null): Promise<RawAuditRow[]> {
  const onlyFilter = onlyEntityId ? sql`AND e.id = ${onlyEntityId}` : sql``;
  const result = await db.execute(sql`
    SELECT
      e.id AS entity_id,
      e.canonical_name,
      COALESCE(u.slack_user_id, e.slack_user_id) AS slack_user_id,
      u.gender AS users_gender,
      e.summary
    FROM entities e
    LEFT JOIN LATERAL (
      SELECT u.gender, u.slack_user_id
      FROM users u
      WHERE u.entity_id = e.id
      ORDER BY u.updated_at DESC NULLS LAST, u.created_at DESC
      LIMIT 1
    ) u ON TRUE
    WHERE e.type = 'person'
      AND e.summary IS NOT NULL
      AND btrim(e.summary) <> ''
      ${onlyFilter}
    ORDER BY e.canonical_name ASC
  `);

  return (result.rows ?? []) as RawAuditRow[];
}

function printSummary(label: string, records: AuditRecord[]): void {
  const counts = {
    total: records.length,
    ok: records.filter((r) => r.status === "ok").length,
    mismatch: records.filter((r) => r.status === "mismatch").length,
    ambiguous: records.filter((r) => r.status === "ambiguous").length,
    noGender: records.filter((r) => r.status === "no_gender").length,
  };

  console.log(`\n${label}`);
  console.table([
    { metric: "total", count: counts.total },
    { metric: "ok", count: counts.ok },
    { metric: "mismatch", count: counts.mismatch },
    { metric: "ambiguous", count: counts.ambiguous },
    { metric: "no_gender", count: counts.noGender },
  ]);
}

function buildAuditCsv(records: AuditRecord[]): string[] {
  const lines: string[] = [];
  lines.push(
    toCsvRow([
      "entity_id",
      "canonical_name",
      "slack_user_id",
      "users_gender",
      "detected_pronouns_counts",
      "detected_class",
      "status",
      "summary_preview",
    ]),
  );

  for (const record of records) {
    lines.push(
      toCsvRow([
        record.entityId,
        record.canonicalName,
        record.slackUserId,
        record.usersGender,
        summarizeCounts(record.counts),
        record.detectedClass,
        record.status,
        record.summaryPreview,
      ]),
    );
  }

  return lines;
}

function buildPostPatchCsv(
  verifications: PostPatchVerification[],
  finalById: Map<string, AuditRecord>,
): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push("post_patch_verification");
  lines.push(
    toCsvRow([
      "entity_id",
      "canonical_name",
      "users_gender",
      "before_detected_class",
      "after_detected_class",
      "before_status",
      "after_status",
      "after_detected_pronouns_counts",
      "clean",
    ]),
  );

  for (const verification of verifications) {
    const final = finalById.get(verification.entityId);
    lines.push(
      toCsvRow([
        verification.entityId,
        verification.canonicalName,
        verification.usersGender,
        verification.beforeDetectedClass,
        verification.afterDetectedClass,
        verification.beforeStatus,
        verification.afterStatus,
        final ? summarizeCounts(final.counts) : "",
        verification.afterStatus === "ok" ? "yes" : "no",
      ]),
    );
  }

  return lines;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const onlyEntityId = parseOnlyEntityId();
  const mode = apply ? "apply" : "dry-run";
  const auditPath = `/tmp/entity-summary-pronoun-audit-${nowStamp(new Date())}.csv`;

  console.log("=== Entity Summary Pronoun Audit ===\n");
  console.log(`mode: ${mode}`);
  console.log(`scope: ${onlyEntityId ? `single entity (${onlyEntityId})` : "all person entities with summaries"}`);
  if (apply) {
    console.log("patch policy: only mismatch rows with users.gender in {male,female}");
  }

  const initialRows = await fetchRows(onlyEntityId);
  const initialRecords = initialRows.map(toAuditRecord);
  const initialById = new Map(initialRecords.map((record) => [record.entityId, record]));
  printSummary("Initial audit summary", initialRecords);

  const csvLines = buildAuditCsv(initialRecords);
  const verifications: PostPatchVerification[] = [];

  const joanInitial = initialById.get(JOAN_ENTITY_ID);
  if (joanInitial) {
    console.log(
      `Joan check (initial): status=${joanInitial.status}, detected=${joanInitial.detectedClass}, users_gender=${joanInitial.usersGender ?? "unknown"}`,
    );
  }

  if (apply) {
    const patchable = initialRecords.filter(
      (record) =>
        record.status === "mismatch" &&
        (record.expectedClass === "masculine" || record.expectedClass === "feminine"),
    );

    console.log(`\nPatch candidates: ${patchable.length}`);
    let patchedCount = 0;

    for (const record of patchable) {
      const patchedSummary =
        record.expectedClass === "masculine"
          ? replaceFemToMasc(record.summary)
          : replaceMascToFem(record.summary);

      if (patchedSummary === record.summary) {
        console.log(`[skip] ${record.entityId} (${record.canonicalName}) - no textual changes produced`);
        continue;
      }

      await db
        .update(entities)
        .set({
          summary: patchedSummary,
          summaryUpdatedAt: new Date(),
        })
        .where(eq(entities.id, record.entityId));

      patchedCount++;
      console.log(`[patched] ${record.entityId} (${record.canonicalName})`);
    }

    console.log(`Patched rows: ${patchedCount}`);

    const finalRows = await fetchRows(onlyEntityId);
    const finalRecords = finalRows.map(toAuditRecord);
    const finalById = new Map(finalRecords.map((record) => [record.entityId, record]));
    printSummary("Post-patch audit summary", finalRecords);

    for (const record of patchable) {
      const after = finalById.get(record.entityId);
      if (!after) continue;

      const verification: PostPatchVerification = {
        entityId: record.entityId,
        canonicalName: record.canonicalName,
        usersGender: record.usersGender,
        beforeDetectedClass: record.detectedClass,
        afterDetectedClass: after.detectedClass,
        beforeStatus: record.status,
        afterStatus: after.status,
      };
      verifications.push(verification);
      console.log(
        `[verify] ${record.entityId} ${record.canonicalName}: ${verification.beforeStatus}/${verification.beforeDetectedClass} -> ${verification.afterStatus}/${verification.afterDetectedClass}`,
      );
    }

    csvLines.push(...buildPostPatchCsv(verifications, finalById));

    const joanFinal = finalById.get(JOAN_ENTITY_ID);
    if (joanFinal) {
      console.log(
        `Joan check (post-patch): status=${joanFinal.status}, detected=${joanFinal.detectedClass}, users_gender=${joanFinal.usersGender ?? "unknown"}`,
      );
    }

    const remainingMismatches = finalRecords.filter((record) => record.status === "mismatch");
    if (remainingMismatches.length > 0) {
      console.error(`\nRemaining mismatches after --apply: ${remainingMismatches.length}`);
      for (const record of remainingMismatches.slice(0, 20)) {
        console.error(
          `- ${record.entityId} (${record.canonicalName}) expected=${record.expectedClass ?? "none"} detected=${record.detectedClass}`,
        );
      }
      process.exitCode = 1;
    }
  }

  await writeFile(auditPath, `${csvLines.join("\n")}\n`, "utf8");
  console.log(`\nAudit CSV written: ${auditPath}`);
}

main().catch((error) => {
  console.error("Script failed:", error);
  process.exit(1);
});
