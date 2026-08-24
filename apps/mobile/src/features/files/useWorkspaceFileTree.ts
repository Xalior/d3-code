import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectEntry, ProjectListDirectoryResult } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import {
  emptyWorkspaceFileTree,
  listedEntries,
  unlistedDirectories,
  withDirectoryListing,
  withExpandedAncestors,
  withExpandedDirectory,
  withoutDirectoryBranch,
  withRootListing,
  withToggledDirectory,
  WORKSPACE_ROOT_DIRECTORY_PATH,
} from "./workspaceFileTree";

export interface WorkspaceFileTree {
  readonly entries: ReadonlyArray<ProjectEntry>;
  readonly expandedPaths: ReadonlySet<string>;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
  /** Opens a directory and its ancestors, for a directory the user reached from search. */
  readonly revealDirectory: (path: string) => void;
  readonly toggleDirectory: (path: string) => void;
}

/**
 * Reads a workspace one directory at a time. The root arrives when the screen
 * opens and every directory the user opens is read on its own, so showing the
 * tree costs the same on a small repository and a huge one. Browsing never
 * consults the whole-workspace search index; searching does, because it has to
 * answer for the whole workspace at once.
 */
export function useWorkspaceFileTree(input: {
  readonly cwd: string | null;
  readonly enabled?: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly selectedPath: string | null;
}): WorkspaceFileTree {
  const { cwd, environmentId, selectedPath } = input;
  const enabled = input.enabled ?? true;
  const rootQuery = useEnvironmentQuery(
    enabled && environmentId !== null && cwd !== null
      ? projectEnvironment.listDirectory({
          environmentId,
          input: { cwd, relativePath: WORKSPACE_ROOT_DIRECTORY_PATH },
        })
      : null,
  );
  const rootEntries = (rootQuery.data as ProjectListDirectoryResult | null)?.entries;
  const [tree, setTree] = useState(emptyWorkspaceFileTree);
  // A read that started before the root was re-read describes a tree that no
  // longer exists, so its result is dropped rather than grafted onto the new one.
  const readingGenerationRef = useRef(0);
  const readingPathsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (rootEntries === undefined) return;
    readingGenerationRef.current += 1;
    readingPathsRef.current = new Set();
    setTree((current) => withRootListing(current, rootEntries));
  }, [rootEntries]);

  useEffect(() => {
    if (selectedPath === null) return;
    setTree((current) => withExpandedAncestors(current, selectedPath));
  }, [selectedPath]);

  const pendingDirectoryPaths = useMemo(() => unlistedDirectories(tree), [tree]);
  useEffect(() => {
    if (environmentId === null || cwd === null) return;
    const generation = readingGenerationRef.current;
    for (const directoryPath of pendingDirectoryPaths) {
      if (readingPathsRef.current.has(directoryPath)) continue;
      readingPathsRef.current.add(directoryPath);
      void executeAtomQuery(
        appAtomRegistry,
        projectEnvironment.listDirectory({
          environmentId,
          input: { cwd, relativePath: directoryPath },
        }),
        { label: "workspace directory listing", reportDefect: false, reportFailure: false },
      ).then((result) => {
        readingPathsRef.current.delete(directoryPath);
        if (generation !== readingGenerationRef.current) return;
        setTree((current) =>
          result._tag === "Success"
            ? withDirectoryListing(current, directoryPath, result.value.entries)
            : withoutDirectoryBranch(current, directoryPath),
        );
      });
    }
  }, [cwd, environmentId, pendingDirectoryPaths]);

  const toggleDirectory = useCallback((path: string) => {
    setTree((current) => withToggledDirectory(current, path));
  }, []);
  const revealDirectory = useCallback((path: string) => {
    setTree((current) => withExpandedDirectory(current, path));
  }, []);
  const entries = useMemo(() => listedEntries(tree), [tree]);

  return {
    entries,
    expandedPaths: tree.expandedPaths,
    error: rootQuery.error,
    isPending: rootQuery.isPending,
    refresh: rootQuery.refresh,
    revealDirectory,
    toggleDirectory,
  };
}
