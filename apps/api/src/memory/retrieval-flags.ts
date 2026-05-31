export const MEMV3_RETRIEVAL_FLAGS = {
  prefilter: "MEMV3_PREFILTER",
  abstention: "MEMV3_ABSTENTION",
  lastMessageWeight: "MEMV3_LASTMSG_WEIGHT",
  scoreFusion: "MEMV3_SCORE_FUSION",
  queryRewrite: "MEMV3_QUERY_REWRITE",
} as const;

export type MemV3RetrievalFlagKey = keyof typeof MEMV3_RETRIEVAL_FLAGS;
export type MemV3RetrievalFlagName =
  (typeof MEMV3_RETRIEVAL_FLAGS)[MemV3RetrievalFlagKey];
export type MemV3RetrievalFlagSnapshot = Record<
  MemV3RetrievalFlagName,
  "0" | "1"
>;

export const MEMV3_RETRIEVAL_FLAG_NAMES = Object.values(
  MEMV3_RETRIEVAL_FLAGS,
) as MemV3RetrievalFlagName[];

/**
 * PR #1059 bisect switches are default-on. Only an explicit env value of "0"
 * disables the corresponding rewrite component; unset/"1"/other values preserve
 * the current branch behavior.
 */
export function isMemV3RetrievalFlagEnabled(
  key: MemV3RetrievalFlagKey,
): boolean {
  return process.env[MEMV3_RETRIEVAL_FLAGS[key]] !== "0";
}

export function getMemV3RetrievalFlagSnapshot(): MemV3RetrievalFlagSnapshot {
  return Object.fromEntries(
    MEMV3_RETRIEVAL_FLAG_NAMES.map((name) => [
      name,
      process.env[name] === "0" ? "0" : "1",
    ]),
  ) as MemV3RetrievalFlagSnapshot;
}

export function formatMemV3RetrievalFlags(
  flags: MemV3RetrievalFlagSnapshot = getMemV3RetrievalFlagSnapshot(),
): string {
  return MEMV3_RETRIEVAL_FLAG_NAMES
    .map((name) => `${name}=${flags[name]}`)
    .join(" ");
}
