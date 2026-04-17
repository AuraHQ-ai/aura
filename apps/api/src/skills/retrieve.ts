import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { notes, skillEmbeddings, skillRetrievals } from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { embedText } from "../lib/embeddings.js";

const SKILL_RETRIEVAL_TOP_K = 5;
const SKILL_EMBEDDING_CONTENT_PREVIEW_CHARS = 500;
const DEFAULT_SKILL_RETRIEVAL_THRESHOLD = 0.35;
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
    .limit(SKILL_RETRIEVAL_TOP_K);

  const aboveThreshold = filterSkillsByThreshold(rows, similarityThreshold);
  const withTokenEstimates = mapRowsToRetrievedSkills(aboveThreshold);
  const capped = applySkillTokenCap(withTokenEstimates, tokenCap);

  logger.info("Semantic skill retrieval complete", {
    workspaceId,
    retrievedCount: capped.length,
    threshold: similarityThreshold,
    tokenCap,
    totalEstimatedTokens: capped.reduce((sum, skill) => sum + skill.estimatedTokens, 0),
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
  await db.insert(skillRetrievals).values(
    params.retrievedSkills.map((skill) => ({
      workspaceId,
      turnId: params.turnId,
      userId: params.userId,
      skillId: skill.id,
      similarity: skill.similarity,
    })),
  );
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
