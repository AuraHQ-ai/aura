import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Ambient workspace scope, established by withWorkspace() in workspace.ts.
 *
 * This module holds ONLY the AsyncLocalStorage store so that client.ts (the
 * `db` proxy) and workspace.ts (the wrapper) can both import it without a
 * circular dependency.
 */
export interface WorkspaceStore {
  workspaceId: string;
  /**
   * Drizzle handle bound to the pinned, workspace-scoped connection. Typed
   * loosely to avoid a type-level dependency on the driver; client.ts casts
   * it back to the public `Database` type.
   */
  handle: unknown;
  /**
   * Flipped to false when withWorkspace() releases the pinned connection.
   * Detached async work that outlives its withWorkspace() scope (e.g. a
   * fire-and-forget promise spawned inside a request handler) falls back to
   * the base driver — identical to pre-RLS behaviour, and fail-closed once
   * the RLS migration is live.
   */
  active: boolean;
}

export const workspaceStorage = new AsyncLocalStorage<WorkspaceStore>();

/** The workspace id of the ambient withWorkspace() scope, if any. */
export function currentWorkspaceId(): string | undefined {
  const store = workspaceStorage.getStore();
  return store?.active ? store.workspaceId : undefined;
}
