import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { notes, skillEmbeddings, skillRetrievals } from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { embedText } from "../lib/embeddings.js";

const DEFAULT_SKILL_RETRIEVAL_TOP_K = 5;
// Raised from 500 to 2000: most skills are <2k chars and critical trigger
// keywords are often in the middle of the content, not the first 500 chars.
const SKILL_EMBEDDING_CONTENT_PREVIEW_CHARS = 2000;
// Threshold bumped from 0.35 (noisy) to 0.55 (actually relevant).
// On text-embedding-3-small, 0.35 matches marginal topical overlap; 0.55 is
// where "this is a skill for this turn" starts. Tune down from telemetry, not up.
const DEFAULT_SKILL_RETRIEVAL_THRESHOLD = 0.55;
const DEFAULT_SKILL_RETRIEVAL_TOKEN_CAP = 4000;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const DEFAULT_WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || "default";

export interface RetrievedSkill {
  id: string;
  topic: string;
  content: string;
  similarity: number;
  estimatedTokens: number;
}

export interface SkillRetrievalRow {
  id: string;
  topic: string;
  content: string;
  similarity: number;
}

interface SkillRetrievalOptions {
  queryEmbedding: number[];
  workspaceId?: string;
}

export interface SkillEmbeddingInput {
  summary: string | null;
  content: string;
}

interface SkillBackfillNote {
  id: string;
  summary: string | null;
  content: string;
}

export function isSkillRetrievalEnabled(): boolean {
  const flag = process.env.ENABLE_SKILL_RETRIEVAL;
  if (flag == null) return true;
  return flag.toLowerCase() !== "false";
}

function getSkillRetrievalTopK(): number {
  const raw = process.env.SKILL_RETRIEVAL_TOP_K;
  if (!raw) return DEFAULT_SKILL_RETRIEVAL_TOP_K;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_SKILL_RETRIEVAL_TOP_K;
}

function getSkillRetrievalThreshold(): number {
  const raw = process.env.SKILL_RETRIEVAL_MIN_SIMILARITY;
  if (!raw) return DEFAULT_SKILL_RETRIEVAL_THRESHOLD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_SKILL_RETRIEVAL_THRESHOLD;
}

function getSkillRetrievalTokenCap(): number {
  const raw = process.env.SKILL_RETRIEVAL_TOKEN_CAP;
  if (!raw) return DEFAULT_SKILL_RETRIEVAL_TOKEN_CAP;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_SKILL_RETRIEVAL_TOKEN_CAP;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

export function buildSkillEmbeddingText(input: SkillEmbeddingInput): string {
  const summaryText = input.summary?.trim() ?? "";
  const triggerMatch = summaryText.match(/load\s+when:\s*(.+)$/i);
  const trigger = triggerMatch ? triggerMatch[1].trim() : summaryText;
  const contentPreview = input.content.slice(0, SKILL_EMBEDDING_CONTENT_PREVIEW_CHARS);

  const parts = [
    `trigger: ${trigger}`,
    `summary: ${summaryText}`,
    `content: ${contentPreview}`,
  ];

  return parts.join("\n\n");
}

export function applySkillTokenCap(skills: RetrievedSkill[], tokenCap: number): RetrievedSkill[] {
  const sorted = [...skills].sort((a, b) => b.similarity - a.similarity);
  let totalTokens = sorted.reduce((sum, skill) => sum + skill.estimatedTokens, 0);

  if (totalTokens <= tokenCap) return sorted;

  const kept = [...sorted];
  while (kept.length > 0 && totalTokens > tokenCap) {
    const removed = kept.pop();
    if (!removed) break;
    totalTokens -= removed.estimatedTokens;
  }

  return kept;
}

export function filterSkillsByThreshold(
  rows: SkillRetrievalRow[],
  threshold: number,
): SkillRetrievalRow[] {
  return rows.filter((row) => row.similarity >= threshold);
}

export function mapRowsToRetrievedSkills(rows: SkillRetrievalRow[]): RetrievedSkill[] {
  return rows.map((row) => ({
    id: row.id,
    topic: row.topic,
    content: row.content,
    similarity: row.similarity,
    estimatedTokens: estimateTokens(row.content),
  }));
}

export async function retrieveSkillsForTurn(
  options: SkillRetrievalOptions,
): Promise<RetrievedSkill[]> {
  if (!isSkillRetrievalEnabled()) {
    return [];
  }

  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const similarityThreshold = getSkillRetrievalThreshold();
  const tokenCap = getSkillRetrievalTokenCap();
  const topK = getSkillRetrievalTopK();
  const vectorSql = sql.raw(`'[${options.queryEmbedding.join(",")}]'::vector`);

  const rows = await db
    .select({
      id: notes.id,
      topic: notes.topic,
      content: notes.content,
      similarity: sql<number>`1 - (${skillEmbeddings.embedding} <=> ${vectorSql})`.as(
        "similarity",
      ),
    })
    .from(skillEmbeddings)
    .innerJoin(notes, eq(skillEmbeddings.id, notes.id))
    .where(
      and(
        eq(skillEmbeddings.workspaceId, workspaceId),
        eq(notes.workspaceId, workspaceId),
        eq(notes.category, "skill"),
        eq(notes.injectInContext, false),
      ),
    )
    .orderBy(sql`${skillEmbeddings.embedding} <=> ${vectorSql}`)
    .limit(topK);

  const aboveThreshold = filterSkillsByThreshold(rows, similarityThreshold);
  const withTokenEstimates = mapRowsToRetrievedSkills(aboveThreshold);
  const capped = applySkillTokenCap(withTokenEstimates, tokenCap);

  // Log top-K *candidates* (pre-threshold) so we can tune threshold from real data.
  // Without this, we can only see what got through, not what was almost-relevant.
  const topCandidates = rows.slice(0, Math.min(rows.length, topK)).map((r) => ({
    id: r.id,
    topic: r.topic,
    similarity: Number(r.similarity.toFixed(4)),
    kept: r.similarity >= similarityThreshold,
  }));

  logger.info("Semantic skill retrieval complete", {
    workspaceId,
    retrievedCount: capped.length,
    candidatesEvaluated: rows.length,
    missedBelowThreshold: rows.length - aboveThreshold.length,
    threshold: similarityThreshold,
    topK,
    tokenCap,
    totalEstimatedTokens: capped.reduce((sum, skill) => sum + skill.estimatedTokens, 0),
    topCandidates,
  });

  return capped;
}

export async function logSkillRetrievals(params: {
  turnId: string;
  userId: string;
  retrievedSkills: RetrievedSkill[];
  workspaceId?: string;
}): Promise<void> {
  if (params.retrievedSkills.length === 0) return;

  const workspaceId = params.workspaceId ?? DEFAULT_WORKSPACE_ID;
  // Fire-and-forget: never block the hot path on telemetry writes.
  // If the insert fails, log it and move on; retrieval already succeeded.
  void db
    .insert(skillRetrievals)
    .values(
      params.retrievedSkills.map((skill) => ({
        workspaceId,
        turnId: params.turnId,
        userId: params.userId,
        skillId: skill.id,
        similarity: skill.similarity,
      })),
    )
    .catch((err) => {
      logger.warn("skill_retrievals insert failed", {
        error: err instanceof Error ? err.message : String(err),
        turnId: params.turnId,
      });
    });
}

export async function upsertSkillEmbedding(params: {
  skillId: string;
  embedding: number[];
  workspaceId?: string;
  updatedAt?: Date;
}): Promise<void> {
  const workspaceId = params.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const updatedAt = params.updatedAt ?? new Date();
  await db
    .insert(skillEmbeddings)
    .values({
      workspaceId,
      id: params.skillId,
      embedding: params.embedding,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [skillEmbeddings.id],
      set: {
        workspaceId,
        embedding: params.embedding,
        updatedAt,
      },
    });
}

export async function deleteSkillEmbedding(skillId: string): Promise<void> {
  await db.delete(skillEmbeddings).where(eq(skillEmbeddings.id, skillId));
}

export async function upsertSkillEmbeddingForNote(params: {
  noteId: string;
  summary: string | null;
  content: string;
  workspaceId?: string;
}): Promise<void> {
  const embeddingInput = buildSkillEmbeddingText({
    summary: params.summary,
    content: params.content,
  });
  const embedding = await embedText(embeddingInput);
  await upsertSkillEmbedding({
    skillId: params.noteId,
    embedding,
    workspaceId: params.workspaceId,
  });
}

export async function getSkillNotesForBackfill(
  batchSize: number,
  offset = 0,
): Promise<SkillBackfillNote[]> {
  return db
    .select({
      id: notes.id,
      summary: notes.summary,
      content: notes.content,
    })
    .from(notes)
    .where(eq(notes.category, "skill"))
    .orderBy(desc(notes.updatedAt))
    .limit(batchSize)
    .offset(offset);
}
