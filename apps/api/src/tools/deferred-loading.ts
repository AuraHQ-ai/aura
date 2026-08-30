/**
 * Pure helpers for Anthropic deferred tool loading markers
 * (providerOptions.anthropic.deferLoading).
 *
 * Kept separate from deferred.ts so lib/ai.ts can import them without
 * pulling in the DB client (deferred.ts imports db/client.js, which throws
 * at module load when DATABASE_URL is unset).
 */

export function hasDeferredLoading(tool: unknown): boolean {
  return Boolean(
    tool &&
      typeof tool === "object" &&
      (tool as { providerOptions?: { anthropic?: { deferLoading?: boolean } } })
        .providerOptions?.anthropic?.deferLoading === true,
  );
}

/** Return a copy of the tool with the deferLoading marker stripped. */
export function withoutDeferredLoading(tool: any): any {
  if (!tool || typeof tool !== "object") return tool;
  const providerOptions = tool.providerOptions ?? {};
  const anthropicOptions = providerOptions.anthropic ?? {};
  const { deferLoading: _deferLoading, ...restAnthropicOptions } = anthropicOptions;
  return {
    ...tool,
    providerOptions: {
      ...providerOptions,
      anthropic: restAnthropicOptions,
    },
  };
}
