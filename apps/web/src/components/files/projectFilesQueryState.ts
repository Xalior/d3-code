import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProjectListDirectoryResult,
  ProjectListEntriesResult,
  ProjectReadFileResult,
} from "@t3tools/contracts";
import {
  isWorkspaceImagePreviewPath,
  isWorkspaceVideoPreviewPath,
} from "@t3tools/shared/filePreview";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { useProjectPathSearch } from "~/state/queries";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

const EMPTY_PROJECT_FILE_PATH = "";
const EMPTY_PROJECT_FILE_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectReadFileResult, never>(false),
).pipe(Atom.withLabel("project-file-query:empty"));
function optimisticFileAtom(environmentId: EnvironmentId, cwd: string, relativePath: string) {
  return projectEnvironment.optimisticFile({ environmentId, cwd, relativePath });
}

interface ProjectQueryState<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

/** The workspace root is addressed by an empty relative path. */
const PROJECT_ROOT_DIRECTORY_PATH = "";

/** Matches the file tree's own ceiling: more rows than this is not a search result. */
const WORKSPACE_ENTRY_SEARCH_LIMIT = 200;
/** How often a search is repeated while the workspace index is still building. */
const INDEXING_POLL_INTERVAL_MS = 2_000;

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

function getProjectEntriesQueryAtom(environmentId: EnvironmentId, cwd: string) {
  return projectEnvironment.listEntries({ environmentId, input: { cwd } });
}

/**
 * The whole-workspace listing, capped by the server. The file tree pages one
 * directory at a time and never uses this; the file breadcrumbs menu is its
 * only consumer, so the full listing is fetched only while a preview is open.
 */
export function useProjectEntriesQuery(
  environmentId: EnvironmentId,
  cwd: string,
): ProjectQueryState<ProjectListEntriesResult> {
  const atom = getProjectEntriesQueryAtom(environmentId, cwd);
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

export function getProjectFileQueryAtom(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
) {
  return projectEnvironment.readFile({
    environmentId,
    input: { cwd, relativePath: relativePath ?? EMPTY_PROJECT_FILE_PATH },
  });
}

export function setProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): void {
  appAtomRegistry.set(optimisticFileAtom(environmentId, cwd, relativePath), {
    confirmedAgainst: undefined,
    data: {
      relativePath,
      contents,
      byteLength: new TextEncoder().encode(contents).byteLength,
      truncated: false,
    },
  });
}

export function getOptimisticProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): ProjectReadFileResult | null {
  return appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath))?.data ?? null;
}

export function confirmProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): boolean {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  const optimisticFile = appAtomRegistry.get(atom);
  if (optimisticFile?.data.contents !== contents) return false;

  const queryAtom = getProjectFileQueryAtom(environmentId, cwd, relativePath);
  const confirmed = {
    ...optimisticFile,
    confirmedAgainst: appAtomRegistry.get(queryAtom),
  };
  appAtomRegistry.set(atom, confirmed);
  appAtomRegistry.refresh(queryAtom);
  void executeAtomQuery(appAtomRegistry, queryAtom, {
    reportDefect: false,
    reportFailure: false,
  }).then((result) => {
    if (result._tag === "Success" && appAtomRegistry.get(atom) === confirmed) {
      appAtomRegistry.set(atom, null);
    }
  });
  return true;
}

export function resolveProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
  data: ProjectReadFileResult | null,
): ProjectReadFileResult | null {
  if (relativePath === null) return data;
  return appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath))?.data ?? data;
}

export function clearProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): void {
  appAtomRegistry.set(optimisticFileAtom(environmentId, cwd, relativePath), null);
}

function errorMessage<A>(result: AsyncResult.AsyncResult<A, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  const cause = Cause.squash(result.cause);
  return cause instanceof Error ? cause.message : "Workspace query failed.";
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
 * Backing query for the project file picker: a debounced, bounded, file-only
 * server search. An empty query is a valid request — the index answers it
 * with frecency-ordered files, so the picker's initial view is recent files
 * without transferring the full workspace listing. `matchedQuery` is the
 * query the returned entries were computed for, so the caller can highlight
 * against results instead of half-typed input.
 */
export function useProjectFilePickerQuery(
  environmentId: EnvironmentId,
  cwd: string,
  query: string,
  limit: number,
  options?: { readonly imageOnly?: boolean },
) {
  const search = useProjectPathSearch(
    {
      environmentId,
      cwd,
      query,
      kind: "file",
      ...(options?.imageOnly ? { imageOnly: true } : {}),
    },
    limit,
    { allowEmptyQuery: true },
  );

  return {
    entries: search.isPending ? [] : search.entries,
    error: search.error,
    isPending: search.isPending,
    matchedQuery: search.searchedQuery,
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

export function useProjectFileQuery(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
  enabled = true,
): ProjectQueryState<ProjectReadFileResult> {
  const isMedia =
    relativePath !== null &&
    (isWorkspaceImagePreviewPath(relativePath) || isWorkspaceVideoPreviewPath(relativePath));
  const atom =
    enabled && !isMedia
      ? getProjectFileQueryAtom(environmentId, cwd, relativePath)
      : EMPTY_PROJECT_FILE_QUERY_ATOM;
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = useCallback(() => refreshAtom(), [refreshAtom]);
  const data = Option.getOrNull(AsyncResult.value(result));
  const optimisticResult = useAtomValue(
    optimisticFileAtom(environmentId, cwd, relativePath ?? EMPTY_PROJECT_FILE_PATH),
  );
  const optimisticFile = relativePath === null ? null : optimisticResult;

  return {
    data: optimisticFile?.data ?? data,
    error: errorMessage(result),
    isPending: result.waiting,
    refresh,
  };
}
