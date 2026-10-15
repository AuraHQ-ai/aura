export const MCP_SERVER_TIMEOUT_MS = 5_000;

export type IsolatedResult<T> = { ok: true; value: T } | { ok: false; error: string };

export async function settleWithTimeout<T>(
  work: () => Promise<T>,
  timeoutMs = MCP_SERVER_TIMEOUT_MS,
): Promise<IsolatedResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`MCP server timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
    return { ok: true, value };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Load tools from many MCP servers in parallel. A timeout or throw from one
 * server never rejects the aggregate — its tools are simply omitted.
 */
export async function loadIsolated<T, R>(
  items: T[],
  loadOne: (item: T) => Promise<R>,
  identify: (item: T) => string,
  timeoutMs = MCP_SERVER_TIMEOUT_MS,
): Promise<{
  results: Array<{ id: string; value: R }>;
  failures: Array<{ id: string; error: string }>;
}> {
  const settled = await Promise.all(
    items.map(async (item) => {
      const id = identify(item);
      const result = await settleWithTimeout(() => loadOne(item), timeoutMs);
      return { id, result };
    }),
  );

  const results: Array<{ id: string; value: R }> = [];
  const failures: Array<{ id: string; error: string }> = [];
  for (const { id, result } of settled) {
    if (result.ok) results.push({ id, value: result.value });
    else failures.push({ id, error: result.error });
  }
  return { results, failures };
}
