import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { useFileTree, useFileTreeSelector } from "@pierre/trees/react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  loadProjectDirectory,
  useProjectDirectoryQuery,
  useWorkspaceEntrySearch,
} from "./d3ProjectDirectoryQueryState";
import {
  ancestorDirectoryPaths,
  directoryRestoreOrder,
  treePath,
  walkOpenDirectories,
  WORKSPACE_ROOT_DIRECTORY_PATH,
} from "./fileTreeDirectories";
import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "./fileTreeExpansion";

/**
 * The file tree, paged in one directory at a time.
 *
 * Upstream's file browser reads the whole workspace listing once and derives the tree from it.
 * This reads the workspace root and nothing else, then reads each directory as the user opens
 * it, so opening the panel costs one directory read no matter how large the workspace is.
 * Searching is a server-side search rather than a filter over the tree, because the tree only
 * holds what the user has already opened.
 *
 * `FileBrowserPanel.tsx` still owns the tree model, the selection refs and the panel's own
 * chrome; everything the paging adds lives here.
 */

type FileTreeModel = ReturnType<typeof useFileTree>["model"];

interface RevealRequest {
  readonly path: string;
  readonly revealId: number;
}

export interface D3PagedFileTreeOptions {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly model: FileTreeModel;
  readonly onOpenFile: (relativePath: string) => void;
  readonly selectedPath: string | null;
  readonly selectedPathRevealId: number;
  /** Kind of every entry the panel has read, which the panel's selection handler also reads. */
  readonly entryKindsRef: { current: Map<string, ProjectEntry["kind"]> };
  readonly syncingSelectionRef: { current: boolean };
  readonly treeSelectionPathRef: { current: string | null };
  readonly handledRevealRef: { current: RevealRequest | null };
}

export function useD3PagedFileTree({
  environmentId,
  cwd,
  model,
  onOpenFile,
  selectedPath,
  selectedPathRevealId,
  entryKindsRef,
  syncingSelectionRef,
  treeSelectionPathRef,
  handledRevealRef,
}: D3PagedFileTreeOptions) {
  const rootQuery = useProjectDirectoryQuery(environmentId, cwd);
  // The tree is paged in one directory at a time, so what the panel knows
  // about the workspace grows between renders rather than being derived from
  // one. It lives in refs; the tree itself is what the user sees change.
  /** Child directories of each directory whose listing has arrived, keyed by that directory. */
  const directoryChildrenRef = useRef<Map<string, readonly string[]>>(new Map());
  const readDirectoriesRef = useRef<Set<string>>(new Set());
  /** Directories the tree holds open, as of the last walk. A refresh reopens these. */
  const expandedDirectoriesRef = useRef<Set<string>>(new Set());
  const inFlightDirectoriesRef = useRef<Map<string, Promise<boolean>>>(new Map());

  const [searchQuery, setSearchQuery] = useState("");
  const isSearching = searchQuery.trim().length > 0;
  const entrySearch = useWorkspaceEntrySearch(environmentId, cwd, searchQuery);

  const registerDirectory = useCallback(
    (relativePath: string, entries: readonly ProjectEntry[]) => {
      const childDirectories: string[] = [];
      for (const entry of entries) {
        entryKindsRef.current.set(entry.path, entry.kind);
        if (entry.kind === "directory") childDirectories.push(entry.path);
      }
      directoryChildrenRef.current.set(relativePath, childDirectories);
      readDirectoriesRef.current.add(relativePath);
    },
    [entryKindsRef],
  );

  // Reads one directory, grafts its children onto the tree, and reports whether
  // the directory could be read at all. Callers racing for the same directory
  // share the one request, so an expand that coincides with a reveal does not
  // read it twice.
  const loadDirectory = useCallback(
    (relativePath: string): Promise<boolean> => {
      if (readDirectoriesRef.current.has(relativePath)) return Promise.resolve(true);
      const inFlight = inFlightDirectoriesRef.current.get(relativePath);
      if (inFlight) return inFlight;
      const request = loadProjectDirectory(environmentId, cwd, relativePath)
        .then((result) => {
          if (result === null) return false;
          registerDirectory(relativePath, result.entries);
          model.batch(
            result.entries.map((entry) => ({ path: treePath(entry), type: "add" as const })),
          );
          return true;
        })
        .finally(() => {
          inFlightDirectoriesRef.current.delete(relativePath);
        });
      inFlightDirectoriesRef.current.set(relativePath, request);
      return request;
    },
    [cwd, environmentId, model, registerDirectory],
  );

  // Reopens the directories the tree held open before it was rebuilt, outermost
  // first. A directory that no longer reads — deleted from disk between
  // refreshes — takes its own branch out of the reopen and leaves the rest of
  // the tree standing.
  const restoreExpandedDirectories = useCallback(
    async (directoryPaths: readonly string[], isCancelled: () => boolean) => {
      const goneDirectoryPaths: string[] = [];
      for (const directoryPath of directoryPaths) {
        if (goneDirectoryPaths.some((gonePath) => directoryPath.startsWith(`${gonePath}/`))) {
          continue;
        }
        const read = await loadDirectory(directoryPath);
        if (isCancelled()) return;
        if (!read) {
          goneDirectoryPaths.push(directoryPath);
          continue;
        }
        const item = model.getItem(`${directoryPath}/`);
        if (item !== null && "expand" in item) item.expand();
      }
    },
    [loadDirectory, model],
  );

  // A file result opens in the preview pane and leaves the results up, so the
  // next result is one click away. A directory has nothing to preview, so it
  // hands the user back to the tree with that directory read and open.
  const handleOpenSearchResult = useCallback(
    (entry: ProjectEntry) => {
      if (entry.kind === "file") {
        onOpenFile(entry.path);
        return;
      }
      setSearchQuery("");
      void (async () => {
        for (const directoryPath of [...ancestorDirectoryPaths(entry.path), entry.path]) {
          if (!(await loadDirectory(directoryPath))) return;
          const item = model.getItem(`${directoryPath}/`);
          if (item !== null && "expand" in item) item.expand();
        }
        model.scrollToPath(`${entry.path}/`, { offset: "center" });
      })();
    },
    [loadDirectory, model, onOpenFile],
  );

  // Every directory the panel has discovered, in the tree's trailing-slash
  // form. This is what "all" means to a paged tree: the unread part of the
  // workspace holds no rows to expand or collapse yet.
  const knownDirectoryTreePaths = useCallback(() => {
    const paths: string[] = [];
    for (const children of directoryChildrenRef.current.values()) {
      for (const childPath of children) paths.push(`${childPath}/`);
    }
    return paths;
  }, []);

  const treeHasDirectories = useFileTreeSelector(model, () => knownDirectoryTreePaths().length > 0);
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, knownDirectoryTreePaths()),
  );

  // A collapse, a refresh, or an unmount lands mid-cascade by bumping the run
  // token; the cascade checks it after every read and stops between two.
  const expandAllRunRef = useRef(0);
  useEffect(() => {
    return () => {
      expandAllRunRef.current += 1;
    };
  }, [model]);

  // Expanding everything in a paged tree is a cascade: each directory read
  // reveals children that also need reading and opening. Reads run one at a
  // time so a large workspace loads politely.
  const expandAllDirectories = useCallback(async () => {
    const run = ++expandAllRunRef.current;
    let frontier: readonly string[] = [WORKSPACE_ROOT_DIRECTORY_PATH];
    while (frontier.length > 0) {
      const discovered: string[] = [];
      for (const directoryPath of frontier) {
        const read = await loadDirectory(directoryPath);
        if (expandAllRunRef.current !== run) return;
        if (!read) continue;
        if (directoryPath !== WORKSPACE_ROOT_DIRECTORY_PATH) {
          const item = model.getItem(`${directoryPath}/`);
          if (item !== null && "expand" in item) item.expand();
        }
        discovered.push(...(directoryChildrenRef.current.get(directoryPath) ?? []));
      }
      frontier = discovered;
    }
  }, [loadDirectory, model]);

  const toggleAllDirectories = () => {
    if (allDirectoriesExpanded) {
      expandAllRunRef.current += 1;
      setAllDirectoriesExpanded(model, knownDirectoryTreePaths(), false);
    } else {
      void expandAllDirectories();
    }
  };

  // The workspace root's own children seed the tree; everything below it is
  // paged in as directories open. A refresh re-reads the root, rebuilds from
  // it, and reopens what the user had open.
  useEffect(() => {
    const rootEntries = rootQuery.data?.entries;
    if (rootEntries === undefined) return;
    expandAllRunRef.current += 1;
    const reopenPaths = directoryRestoreOrder(expandedDirectoriesRef.current);
    entryKindsRef.current = new Map();
    directoryChildrenRef.current = new Map();
    readDirectoriesRef.current = new Set();
    expandedDirectoriesRef.current = new Set();
    inFlightDirectoriesRef.current = new Map();
    registerDirectory(WORKSPACE_ROOT_DIRECTORY_PATH, rootEntries);
    model.resetPaths(rootEntries.map(treePath));
    if (reopenPaths.length === 0) return;
    let cancelled = false;
    void restoreExpandedDirectories(reopenPaths, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [entryKindsRef, model, registerDirectory, restoreExpandedDirectories, rootQuery.data]);

  // `@pierre/trees` drops expand and collapse from onMutation, so nothing
  // announces that a directory was opened and the tree has to be read back.
  // Each controller notification schedules one walk on the next frame, so a
  // burst of them, such as a run of selection changes, costs a single pass,
  // and that pass covers the open part of the tree rather than every directory
  // the panel has discovered.
  useEffect(() => {
    let scheduledFrame: number | null = null;
    const walkTree = () => {
      scheduledFrame = null;
      const walk = walkOpenDirectories({
        childDirectories: (directoryPath) => directoryChildrenRef.current.get(directoryPath) ?? [],
        isExpanded: (directoryPath) => {
          const item = model.getItem(`${directoryPath}/`);
          return item !== null && "isExpanded" in item && item.isExpanded();
        },
        isRead: (directoryPath) => readDirectoriesRef.current.has(directoryPath),
      });
      for (const directoryPath of walk.closedPaths) {
        expandedDirectoriesRef.current.delete(directoryPath);
      }
      for (const directoryPath of walk.openPaths) {
        expandedDirectoriesRef.current.add(directoryPath);
      }
      for (const directoryPath of walk.unreadPaths) {
        void loadDirectory(directoryPath);
      }
    };
    const scheduleWalk = () => {
      if (scheduledFrame !== null) return;
      scheduledFrame = requestAnimationFrame(walkTree);
    };
    scheduleWalk();
    const unsubscribe = model.subscribe(scheduleWalk);
    return () => {
      if (scheduledFrame !== null) cancelAnimationFrame(scheduledFrame);
      unsubscribe();
    };
  }, [loadDirectory, model]);

  useEffect(() => {
    if (!selectedPath) {
      handledRevealRef.current = null;
      return;
    }
    // The tree is not on screen while search results are, and revealing into a
    // hidden tree would take focus off the search field. The reveal is left
    // outstanding and runs when the results are dismissed.
    if (isSearching) return;
    const revealRequest = { path: selectedPath, revealId: selectedPathRevealId };
    const handledReveal = handledRevealRef.current;
    // A refresh re-seeds the tree while the same preview stays open. Replaying
    // a handled reveal would close an active tree search and steal focus.
    if (
      handledReveal?.path === revealRequest.path &&
      handledReveal.revealId === revealRequest.revealId
    ) {
      return;
    }
    handledRevealRef.current = revealRequest;

    let cancelled = false;
    const reveal = async () => {
      // The file may sit under directories nobody has expanded, so read the
      // chain down to it before looking for its row.
      for (const ancestorPath of ancestorDirectoryPaths(selectedPath)) {
        await loadDirectory(ancestorPath);
        if (cancelled) return;
      }
      if (entryKindsRef.current.get(selectedPath) !== "file") return;
      const selectedItem = model.getItem(selectedPath);
      if (!selectedItem) return;

      // A selection that originated inside the tree (clicking a row) is
      // already visible; re-revealing it would scroll the tree out from under
      // the user. Only sync external opens (file picker, content search, chat
      // links).
      const selectedInTree = model
        .getSelectedPaths()
        .some((path) => path.replace(/\/$/, "") === selectedPath);
      if (selectedInTree && treeSelectionPathRef.current === selectedPath) {
        treeSelectionPathRef.current = null;
        return;
      }
      treeSelectionPathRef.current = null;

      syncingSelectionRef.current = true;
      for (const path of model.getSelectedPaths()) {
        model.getItem(path)?.deselect();
      }

      // Directory rows are registered with a trailing slash (see treePath), so
      // ancestor lookups must use the same form to expand them.
      for (const ancestorPath of ancestorDirectoryPaths(selectedPath)) {
        const item = model.getItem(`${ancestorPath}/`) ?? model.getItem(ancestorPath);
        if (item && "expand" in item) item.expand();
      }

      selectedItem.select();
      model.scrollToPath(selectedPath, { focus: true, offset: "center" });
      queueMicrotask(() => {
        syncingSelectionRef.current = false;
      });
    };
    void reveal();
    return () => {
      cancelled = true;
    };
  }, [
    entryKindsRef,
    handledRevealRef,
    isSearching,
    loadDirectory,
    model,
    selectedPath,
    selectedPathRevealId,
    syncingSelectionRef,
    treeSelectionPathRef,
  ]);

  return {
    rootQuery,
    searchQuery,
    setSearchQuery,
    isSearching,
    entrySearch,
    treeHasDirectories,
    allDirectoriesExpanded,
    toggleAllDirectories,
    handleOpenSearchResult,
  };
}
