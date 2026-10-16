import type { MemoryFactClass } from "@aura/db/schema";

/**
 * Class-based expiry for volatile facts (#1557).
 *
 * The extractor (and the nightly contradiction pass) assign a *class*.
 * This module maps class → default valid_until. storeMemories must NOT
 * stamp a formula on every row — that is the #1171 anti-pattern
 * (event=14d / open_thread=30d for all rows of those types).
 *
 * Durable memories (no factClass) keep valid_until NULL until supersession
 * or an explicit caller-supplied window closes them.
 */

export const MEMORY_FACT_CLASSES = [
  "access",
  "permissions",
  "pricing",
  "url",
  "tool_status",
] as const satisfies readonly MemoryFactClass[];

export type { MemoryFactClass };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default validity window, in days, per volatile class. */
export const FACT_CLASS_TTL_DAYS: Record<MemoryFactClass, number> = {
  access: 14,
  permissions: 14,
  pricing: 30,
  url: 30,
  tool_status: 7,
};

export function isMemoryFactClass(value: unknown): value is MemoryFactClass {
  return typeof value === "string" && (MEMORY_FACT_CLASSES as readonly string[]).includes(value);
}

/** Volatile classes should be verified before the model asserts them as current. */
export function needsVerifyBeforeAsserting(factClass: unknown): boolean {
  return isMemoryFactClass(factClass);
}

/**
 * Compute the class-based valid_until for a volatile fact.
 * Anchored on validFrom (when we learned it), not wall-clock now — a 60-day-old
 * access claim classified tonight expires immediately rather than getting a
 * fresh 14-day lease.
 */
export function validUntilForFactClass(factClass: MemoryFactClass, validFrom: Date): Date {
  return new Date(validFrom.getTime() + FACT_CLASS_TTL_DAYS[factClass] * DAY_MS);
}

/**
 * Fields to persist on a newly extracted (or nightly-classified) memory.
 * Empty when the extractor left the class unset — those rows stay durable.
 */
export function expiryFieldsForFactClass(
  factClass: string | null | undefined,
  validFrom: Date,
): { factClass: MemoryFactClass; validUntil: Date } | Record<string, never> {
  if (!isMemoryFactClass(factClass)) return {};
  return {
    factClass,
    validUntil: validUntilForFactClass(factClass, validFrom),
  };
}
