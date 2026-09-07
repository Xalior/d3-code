import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectListDirectoryResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { useProjectPathSearch } from "~/state/queries";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

/**
 * Queries behind the paged file tree.
 *
 * The file tree reads one directory at a time rather than the whole workspace listing
 * `projectFilesQueryState.ts` provides, so it needs a query per directory and a server-side
 * search to reach the directories it has not opened. Those live here, apart from the shared
 * query state that file owns.
 */

/** The workspace root is addressed by an empty relative path. */
const PROJECT_ROOT_DIRECTORY_PATH = "";

/** Matches the file tree's own ceiling: more rows than this is not a search result. */
const WORKSPACE_ENTRY_SEARCH_LIMIT = 200;

/** How often a search is repeated while the workspace index is still building. */
const INDEXING_POLL_INTERVAL_MS = 2_000;

/** Mirrors the `ProjectQueryState` interface in `projectFilesQueryState.ts`. */
export interface ProjectQueryState<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

/** Mirrors the `errorMessage` helper in `projectFilesQueryState.ts`. */
function errorMessage<A>(result: AsyncResult.AsyncResult<A, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  const cause = Cause.squash(result.cause);
  return cause instanceof Error ? cause.message : "Workspace query failed.";
}

export function getProjectDirectoryQueryAtom(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
) {
  return projectEnvironment.listDirectory({ environmentId, input: { cwd, relativePath } });
}

/**
 * Reads one directory outside React's render cycle. The file tree expands on
 * user input rather than on a rendered path list, so the directories it needs
 * are not knowable from hook order; this drives the same query atom family
 * imperatively instead.
 */
export async function loadProjectDirectory(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): Promise<ProjectListDirectoryResult | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectDirectoryQueryAtom(environmentId, cwd, relativePath),
    { reportDefect: false, reportFailure: false },
  );
  return result._tag === "Success" ? result.value : null;
}

/**
 * Backing query for the file tree's root level. Only the workspace root's own
 * children are read here; everything below arrives through
 * {@link loadProjectDirectory} as the user expands directories, so opening the
 * panel costs one directory read no matter how large the workspace is.
 */
export function useProjectDirectoryQuery(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string = PROJECT_ROOT_DIRECTORY_PATH,
): ProjectQueryState<ProjectListDirectoryResult> {
  const atom = getProjectDirectoryQueryAtom(environmentId, cwd, relativePath);
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = useCallback(() => refreshAtom(), [refreshAtom]);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: errorMessage(result),
    isPending: result.waiting,
    refresh,
  };
}

/**
 * Backing query for the file tree's search field: a debounced, bounded search
 * of the whole workspace, files and directories alike. The tree itself only
 * holds the directories the user has opened, so filtering it locally would
 * only ever find what had already been read.
 *
 * A workspace large enough that its index is still being built answers from
 * the part already read, so the same query is repeated while the scan runs and
 * the result list grows with it.
 */
export function useWorkspaceEntrySearch(environmentId: EnvironmentId, cwd: string, query: string) {
  const search = useProjectPathSearch({ environmentId, cwd, query }, WORKSPACE_ENTRY_SEARCH_LIMIT);
  const isScanning = search.indexStatus?.isScanning === true;
  // Held in a ref so the poll survives the renders between two results: the
  // refresh callback belongs to the current query atom, and re-running the
  // effect for a new identity would restart the interval before it ever fires.
  const refreshRef = useRef(search.refresh);
  refreshRef.current = search.refresh;
  useEffect(() => {
    if (!isScanning) return;
    const interval = setInterval(() => refreshRef.current(), INDEXING_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isScanning]);

  return search;
}
