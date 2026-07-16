import { config } from "dotenv";
import { writeFile } from "fs/promises";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { entities, users } from "@aura/db/schema";
import type { Database } from "../db/client.js";
import {
  classifyPronounSummary,
  normalizeGenderToPronounFamily,
  patchSimplePronounMismatch,
  scanPronouns,
  type PronounFamily,
} from "../lib/pronoun-audit.js";

const DEFAULT_CANARY_ENTITY_ID = "f212a72d-a781-4af6-990b-2a908bf3c1e6";
const CANARY_ENTITY_ID =
  process.env.PRONOUN_AUDIT_CANARY_ENTITY_ID ?? DEFAULT_CANARY_ENTITY_ID;

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");

type ClassificationKind =
  | "MATCH"
  | "MISMATCH_SIMPLE"
  | "MISMATCH_COMPLEX"
  | "SKIP_NO_GENDER"
  | "SKIP_UNKNOWN_GENDER";

interface AuditEntityRow {
  id: string;
  workspaceId: string;
  canonicalName: string;
  slackUserId: string | null;
  summary: string | null;
  gender: string | null;
}

interface CsvRow {
  entityId: string;
  workspaceId: string;
  canonicalName: string;
  slackUserId: string;
  gender: string;
  expectedFamily: string;
  classification: ClassificationKind;
  reason: string;
  counts: string;
  beforeSummary: string;
  afterSummary: string;
  ambiguousChoices: string;
}

interface AuditSummary {
  totalAudited: number;
  match: number;
  mismatchSimplePatched: number;
  mismatchSimpleDetected: number;
  mismatchSimpleSkippedAmbiguous: number;
  mismatchComplexQueued: number;
  skippedNoGender: number;
  skippedUnknownGender: number;
}

interface CliOptions {
  apply: boolean;
  dryRun: boolean;
  isProd: boolean;
  /**
   * When true, rows whose patch would depend on ambiguous `her` disambiguation
   * are surfaced for manual review instead of auto-patched. Default true.
   */
  skipAmbiguousHer: boolean;
}

function parseCliOptions(args: string[]): CliOptions {
  const argSet = new Set(args);
  const apply = argSet.has("--apply");
  const dryRunFlag = argSet.has("--dry-run");
  const isProd = argSet.has("--prod");
  // Default behaviour is to SKIP ambiguous `her` resolutions so we don't silently
  // write bad patches. --allow-ambiguous-her opts into the older permissive mode.
  const allowAmbiguous = argSet.has("--allow-ambiguous-her");

  const knownFlags = new Set([
    "--apply",
    "--dry-run",
    "--prod",
    "--allow-ambiguous-her",
  ]);
  const unknownArgs = args.filter((arg) => !knownFlags.has(arg));
  if (unknownArgs.length > 0) {
    throw new Error(
      `Unknown arguments: ${unknownArgs.join(", ")}\n` +
        "Usage: pnpm tsx scripts/pronoun-audit.ts [--dry-run] [--apply] [--prod] [--allow-ambiguous-her]",
    );
  }

  if (apply && dryRunFlag) {
    throw new Error("Use either --apply or --dry-run, not both.");
  }

  return {
    apply,
    dryRun: dryRunFlag || !apply,
    isProd,
    skipAmbiguousHer: !allowAmbiguous,
  };
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function toCsv(rows: CsvRow[]): string {
  const header = [
    "entity_id",
    "workspace_id",
    "canonical_name",
    "slack_user_id",
    "gender",
    "expected_family",
    "classification",
    "reason",
    "counts",
    "before_summary",
    "after_summary",
    "ambiguous_choices",
  ];

  const lines = [header.join(",")];

  for (const row of rows) {
    const values = [
      row.entityId,
      row.workspaceId,
      row.canonicalName,
      row.slackUserId,
      row.gender,
      row.expectedFamily,
      row.classification,
      row.reason,
      row.counts,
      row.beforeSummary,
      row.afterSummary,
      row.ambiguousChoices,
    ];
    lines.push(values.map((value) => csvEscape(value)).join(","));
  }

  return `${lines.join("\n")}\n`;
}

function formatCounts(summary: string): string {
  const { counts } = scanPronouns(summary);
  return `feminine=${counts.feminine};masculine=${counts.masculine};neutral=${counts.neutral}`;
}

async function loadAuditRows(db: Database): Promise<AuditEntityRow[]> {
  return db
    .select({
      id: entities.id,
      workspaceId: entities.workspaceId,
      canonicalName: entities.canonicalName,
      slackUserId: entities.slackUserId,
      summary: entities.summary,
      gender: users.gender,
    })
    .from(entities)
    .innerJoin(
      users,
      and(
        eq(entities.workspaceId, users.workspaceId),
        eq(entities.slackUserId, users.slackUserId),
      ),
    )
    .where(
      and(
        isNotNull(entities.slackUserId),
        isNotNull(entities.summary),
        sql`trim(${entities.summary}) <> ''`,
      ),
    );
}

function expectedFamilyOrSkip(
  gender: string | null,
): { expectedFamily: PronounFamily | null; skipKind: ClassificationKind | null } {
  if (gender == null || gender.trim() === "") {
    return { expectedFamily: null, skipKind: "SKIP_NO_GENDER" };
  }

  const expectedFamily = normalizeGenderToPronounFamily(gender);
  if (!expectedFamily) {
    return { expectedFamily: null, skipKind: "SKIP_UNKNOWN_GENDER" };
  }

  return { expectedFamily, skipKind: null };
}

async function verifyCanarySummary(db: Database): Promise<void> {
  const rows = await db
    .select({
      id: entities.id,
      summary: entities.summary,
    })
    .from(entities)
    .where(eq(entities.id, CANARY_ENTITY_ID))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new Error(`Verification failed: canary entity ${CANARY_ENTITY_ID} not found.`);
  }
  if (!row.summary || row.summary.trim() === "") {
    throw new Error("Verification failed: canary summary is empty.");
  }

  const classification = classifyPronounSummary(row.summary, "masculine");
  const scan = scanPronouns(row.summary);
  if (
    classification.kind !== "MATCH" ||
    scan.counts.masculine === 0 ||
    scan.counts.feminine > 0 ||
    scan.counts.neutral > 0
  ) {
    // NOTE: canary gender is expected to be masculine; override via PRONOUN_AUDIT_CANARY_ENTITY_ID
      // if you pick a different canary.
      throw new Error(
        "Verification failed: canary summary does not end in he/him pronouns only.",
      );
  }
}

export async function main(args: string[]): Promise<void> {
  const options = parseCliOptions(args);
  const envFile = options.isProd ? ".env.production" : ".env.local";
  config({ path: resolve(repoRoot, envFile) });
  const { db } = await import("../db/client.js");

  const runTimestamp = Date.now();
  const csvPath = `/tmp/pronoun_audit_${runTimestamp}.csv`;
  const rollbackSqlPath = `/tmp/pronoun_audit_${runTimestamp}.rollback.sql`;
  const csvRows: CsvRow[] = [];
  const rollbackStatements: string[] = [];
  const summary: AuditSummary = {
    totalAudited: 0,
    match: 0,
    mismatchSimplePatched: 0,
    mismatchSimpleDetected: 0,
    mismatchSimpleSkippedAmbiguous: 0,
    mismatchComplexQueued: 0,
    skippedNoGender: 0,
    skippedUnknownGender: 0,
  };

  console.log("=== Entity Pronoun Audit ===");
  console.log(`Mode: ${options.apply ? "apply" : "dry-run"}`);
  if (options.isProd) console.log("Using .env.production (--prod)");

  const rows = await loadAuditRows(db);
  const now = new Date();

  for (const row of rows) {
    if (!row.summary || !row.slackUserId) continue;

    const expected = expectedFamilyOrSkip(row.gender);
    if (!expected.expectedFamily) {
      if (expected.skipKind === "SKIP_NO_GENDER") summary.skippedNoGender += 1;
      if (expected.skipKind === "SKIP_UNKNOWN_GENDER") {
        summary.skippedUnknownGender += 1;
      }
      continue;
    }

    summary.totalAudited += 1;
    const classification = classifyPronounSummary(row.summary, expected.expectedFamily);

    if (classification.kind === "MATCH") {
      summary.match += 1;
      continue;
    }

    if (classification.kind === "MISMATCH_SIMPLE") {
      summary.mismatchSimpleDetected += 1;

      // Always preview the patch up-front so we can gate on ambiguity before writing.
      const previewPatch = patchSimplePronounMismatch(
        row.summary,
        classification.sourceFamily,
        classification.targetFamily,
      );
      const hasAmbiguous = previewPatch.ambiguousChoices.length > 0;

      if (options.skipAmbiguousHer && hasAmbiguous) {
        summary.mismatchSimpleSkippedAmbiguous += 1;
        csvRows.push({
          entityId: row.id,
          workspaceId: row.workspaceId,
          canonicalName: row.canonicalName,
          slackUserId: row.slackUserId,
          gender: row.gender ?? "",
          expectedFamily: classification.targetFamily,
          classification: "MISMATCH_SIMPLE",
          reason:
            "" + classification.reason +
            " (skipped: ambiguous her disambiguation; re-run with --allow-ambiguous-her to patch, or regenerate via entity summary pipeline)",
          counts: formatCounts(row.summary),
          beforeSummary: row.summary,
          afterSummary: previewPatch.summary,
          ambiguousChoices: previewPatch.ambiguousChoices.join(" | "),
        });
        continue;
      }

      if (options.apply) {
        await db
          .update(entities)
          .set({
            summary: previewPatch.summary,
            summaryUpdatedAt: now,
            updatedAt: now,
          })
          .where(eq(entities.id, row.id));

        // Capture a precise rollback statement for every write.
        const escapedBefore = row.summary.replace(/'/g, "''");
        rollbackStatements.push(
          `UPDATE entities SET summary = '${escapedBefore}' WHERE id = '${row.id}';`,
        );

        const patchedClassification = classifyPronounSummary(
          previewPatch.summary,
          classification.targetFamily,
        );
        if (patchedClassification.kind !== "MATCH") {
          throw new Error(
            `Patch did not converge for entity ${row.id}: ${patchedClassification.reason}`,
          );
        }

        summary.mismatchSimplePatched += 1;
        csvRows.push({
          entityId: row.id,
          workspaceId: row.workspaceId,
          canonicalName: row.canonicalName,
          slackUserId: row.slackUserId,
          gender: row.gender ?? "",
          expectedFamily: classification.targetFamily,
          classification: "MISMATCH_SIMPLE",
          reason: classification.reason,
          counts: formatCounts(row.summary),
          beforeSummary: row.summary,
          afterSummary: previewPatch.summary,
          ambiguousChoices: previewPatch.ambiguousChoices.join(" | "),
        });
      } else {
        csvRows.push({
          entityId: row.id,
          workspaceId: row.workspaceId,
          canonicalName: row.canonicalName,
          slackUserId: row.slackUserId,
          gender: row.gender ?? "",
          expectedFamily: classification.targetFamily,
          classification: "MISMATCH_SIMPLE",
          reason: `${classification.reason} (dry-run, not patched)`,
          counts: formatCounts(row.summary),
          beforeSummary: row.summary,
          afterSummary: row.summary,
          ambiguousChoices: "",
        });
      }

      continue;
    }

    summary.mismatchComplexQueued += 1;
    csvRows.push({
      entityId: row.id,
      workspaceId: row.workspaceId,
      canonicalName: row.canonicalName,
      slackUserId: row.slackUserId,
      gender: row.gender ?? "",
      expectedFamily: classification.targetFamily,
      classification: "MISMATCH_COMPLEX",
      reason: classification.reason,
      counts: formatCounts(row.summary),
      beforeSummary: row.summary,
      afterSummary: "",
      ambiguousChoices: "",
    });
  }

  if (options.apply) {
    const postRows = await loadAuditRows(db);
    const remainingSimpleMismatches = postRows.reduce((count, row) => {
      if (!row.summary) return count;
      const expected = normalizeGenderToPronounFamily(row.gender);
      if (!expected) return count;
      const classification = classifyPronounSummary(row.summary, expected);
      if (classification.kind !== "MISMATCH_SIMPLE") return count;
      // Ambiguous-her skips are expected residue when running with the default flag.
      if (options.skipAmbiguousHer) {
        const preview = patchSimplePronounMismatch(
          row.summary,
          classification.sourceFamily,
          classification.targetFamily,
        );
        if (preview.ambiguousChoices.length > 0) return count;
      }
      return count + 1;
    }, 0);

    if (remainingSimpleMismatches > 0) {
      throw new Error(
        `Idempotency check failed: ${remainingSimpleMismatches} non-ambiguous simple mismatches remain after --apply.`,
      );
    }
  }

  await verifyCanarySummary(db);
  await writeFile(csvPath, toCsv(csvRows), "utf8");
  if (options.apply && rollbackStatements.length > 0) {
    const header = `-- Pronoun audit rollback generated at ${new Date(runTimestamp).toISOString()}\n` +
      `-- ${rollbackStatements.length} UPDATE statement(s). Run inside a transaction.\n`;
    await writeFile(
      rollbackSqlPath,
      header + "BEGIN;\n" + rollbackStatements.join("\n") + "\nCOMMIT;\n",
      "utf8",
    );
  }

  console.log("\n=== Pronoun Audit Summary ===");
  console.log(`total_audited: ${summary.totalAudited}`);
  console.log(`match: ${summary.match}`);
  console.log(`mismatch_simple_patched: ${summary.mismatchSimplePatched}`);
  console.log(`mismatch_complex_queued: ${summary.mismatchComplexQueued}`);
  console.log(`csv_path: ${csvPath}`);

  if (summary.mismatchSimpleDetected > summary.mismatchSimplePatched) {
    console.log(
      `mismatch_simple_detected_unpatched: ${
        summary.mismatchSimpleDetected - summary.mismatchSimplePatched
      }`,
    );
  }
  if (summary.mismatchSimpleSkippedAmbiguous > 0) {
    console.log(
      `mismatch_simple_skipped_ambiguous: ${summary.mismatchSimpleSkippedAmbiguous} ` +
        `(use --allow-ambiguous-her to patch, or regenerate via summary pipeline)`,
    );
  }
  if (options.apply && rollbackStatements.length > 0) {
    console.log(`rollback_sql_path: ${rollbackSqlPath}`);
  }
  if (summary.skippedNoGender > 0 || summary.skippedUnknownGender > 0) {
    console.log(`skipped_no_gender: ${summary.skippedNoGender}`);
    console.log(`skipped_unknown_gender: ${summary.skippedUnknownGender}`);
  }
}

if (import.meta.url === new URL(process.argv[1], "file://").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error("Script failed:", error);
    process.exit(1);
  });
}
