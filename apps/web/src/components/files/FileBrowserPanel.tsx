import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
} from "@pierre/trees";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { T3_PIERRE_ICONS } from "~/pierre-icons";

import {
  ancestorDirectoryPaths,
  directoryRestoreOrder,
  treePath,
  walkOpenDirectories,
  WORKSPACE_ROOT_DIRECTORY_PATH,
} from "./fileTreeDirectories";
import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import { loadProjectDirectory, useProjectDirectoryQuery } from "./projectFilesQueryState";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  /** File currently open in the preview pane; revealed and selected in the tree. */
  selectedPath: string | null;
  /** Bumped when the same path should be revealed again (e.g. re-opened from search). */
  selectedPathRevealId: number;
  onOpenFile: (relativePath: string) => void;
  onRefreshSelectedFile?: () => void;
}

const TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 5px; }
`;

function RefreshFilesButton(props: { isPending: boolean; onRefresh: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh workspace files"
            onClick={props.onRefresh}
          />
        }
      >
        <RotateCw className={cn(props.isPending && "animate-spin")} />
      </TooltipTrigger>
      <TooltipPopup>{props.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
    </Tooltip>
  );
}

function FileSearchField(props: {
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onValueChange: (value: string) => void;
  value: string;
}) {
  return (
    <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
      <InputGroupInput
        type="search"
        name={props.name}
        size="sm"
        value={props.value}
        aria-label={props.ariaLabel}
        placeholder="Search files"
        spellCheck={false}
        onChange={(event) => props.onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          props.onClose();
          event.currentTarget.blur();
        }}
      />
    </InputGroup>
  );
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  selectedPath,
  selectedPathRevealId,
  onOpenFile,
  onRefreshSelectedFile,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const composerRef = useComposerHandleContext();
  const rootQuery = useProjectDirectoryQuery(environmentId, cwd);
  // The tree is paged in one directory at a time, so what the panel knows
  // about the workspace grows between renders rather than being derived from
  // one. It lives in refs; the tree itself is what the user sees change.
  const entryKindsRef = useRef<Map<string, ProjectEntry["kind"]>>(new Map());
  /** Child directories of each directory whose listing has arrived, keyed by that directory. */
  const directoryChildrenRef = useRef<Map<string, readonly string[]>>(new Map());
  const readDirectoriesRef = useRef<Set<string>>(new Set());
  /** Directories the tree holds open, as of the last walk. A refresh reopens these. */
  const expandedDirectoriesRef = useRef<Set<string>>(new Set());
  const inFlightDirectoriesRef = useRef<Map<string, Promise<boolean>>>(new Map());
  const syncingSelectionRef = useRef(false);
  const treeSelectionPathRef = useRef<string | null>(null);
  const handledRevealRef = useRef<{ path: string; revealId: number } | null>(null);

  // The tree renders rows in shadow DOM and its anchor rect is unreliable, so
  // capture the right-click position ourselves; contextmenu is a composed
  // event, so a capture-phase listener sees it with viewport coordinates.
  const contextMenuPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);
  useEffect(() => {
    const capturePointer = (event: MouseEvent) => {
      contextMenuPointerRef.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    };
    document.addEventListener("contextmenu", capturePointer, true);
    return () => document.removeEventListener("contextmenu", capturePointer, true);
  }, []);

  const showEntryContextMenu = async (
    item: TreeContextMenuItem,
    context: TreeContextMenuOpenContext,
  ) => {
    const api = readLocalApi();
    if (!api) {
      context.close();
      return;
    }
    const relativePath = item.path.replace(/\/$/, "");
    const mention = serializeComposerFileLink(relativePath);
    const pointer = contextMenuPointerRef.current;
    const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
    const anchorRect = context.anchorElement.getBoundingClientRect();
    const position = pointerIsFresh
      ? { x: pointer.x, y: pointer.y }
      : { x: anchorRect.left, y: anchorRect.bottom };
    try {
      const clicked = await api.contextMenu.show(
        [
          { id: "copy-mention", label: "Copy mention" },
          { id: "add-to-chat", label: "Add to chat" },
        ],
        position,
      );
      if (clicked === "copy-mention") {
        try {
          await writeTextToClipboard(mention);
          toastManager.add({ type: "success", title: "Mention copied", description: relativePath });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to copy mention",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }
      if (clicked === "add-to-chat") {
        const composer = composerRef?.current;
        if (!composer) {
          toastManager.add({
            type: "error",
            title: "Unable to add to chat",
            description: "Open a chat for this project and try again.",
          });
          return;
        }
        const inserted = composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true });
        if (!inserted) {
          toastManager.add({
            type: "error",
            title: "Unable to add to chat",
            description: "The chat isn't ready to accept input right now.",
          });
        }
      }
    } finally {
      context.close();
    }
  };
  const showEntryContextMenuRef = useRef(showEntryContextMenu);
  useEffect(() => {
    showEntryContextMenuRef.current = showEntryContextMenu;
  });

  const treeModelRef = useRef<ReturnType<typeof useFileTree>["model"] | null>(null);
  const dragMention = useMemo(
    () =>
      createFileTreeDragMentionController({
        deselect: (path) => treeModelRef.current?.getItem(path)?.deselect(),
      }),
    [],
  );
  const { model } = useFileTree({
    composition: {
      contextMenu: {
        triggerMode: "right-click",
        onOpen: (item, context) => {
          void showEntryContextMenuRef.current(item, context);
        },
      },
    },
    // Rows only need to be draggable so entries can be dropped into the chat
    // composer; rearranging files inside the tree stays off.
    dragAndDrop: { canDrop: () => false },
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      // The drag controller's selection cache must track every change,
      // including reveal-driven ones, or drags act on a stale selection.
      dragMention.handleSelectionChange(selectedPaths);
      // Selection changes driven by the reveal sync below are echoes of an
      // already-open file, not a request to open it again.
      if (syncingSelectionRef.current) return;
      // Starting a drag selects the dragged row; that selection is a side
      // effect of the gesture, not a request to open the file.
      if (dragMention.isDragInProgress()) {
        return;
      }
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) === "file") {
        treeSelectionPathRef.current = selectedPath;
        onOpenFile(selectedPath);
      }
    },
    paths: [],
    search: false,
    unsafeCSS: TREE_UNSAFE_CSS,
  });
  const search = useFileTreeSearch(model);
  const handleSearchValueChange = (value: string) => {
    if (value.trim().length === 0) {
      search.close();
      return;
    }
    search.setValue(value);
  };
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
    [],
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

  const handleRefresh = () => {
    rootQuery.refresh();
    onRefreshSelectedFile?.();
  };

  // The workspace root's own children seed the tree; everything below it is
  // paged in as directories open. A refresh re-reads the root, rebuilds from
  // it, and reopens what the user had open.
  useEffect(() => {
    const rootEntries = rootQuery.data?.entries;
    if (rootEntries === undefined) return;
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
  }, [model, registerDirectory, restoreExpandedDirectories, rootQuery.data]);

  // `@pierre/trees` drops expand and collapse from onMutation, so nothing
  // announces that a directory was opened and the tree has to be read back.
  // Each controller notification schedules one walk on the next frame, so a
  // burst of them — a selection change, a run of search keystrokes — costs a
  // single pass, and that pass covers the open part of the tree rather than
  // every directory the panel has discovered.
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

      // A selection that originated inside the tree (clicking a row, possibly
      // in an active tree search) is already visible; re-revealing it would
      // close the search and clobber the user's context. Only sync external
      // opens (file picker, content search, chat links).
      const selectedInTree = model
        .getSelectedPaths()
        .some((path) => path.replace(/\/$/, "") === selectedPath);
      if (selectedInTree && treeSelectionPathRef.current === selectedPath) {
        treeSelectionPathRef.current = null;
        return;
      }
      treeSelectionPathRef.current = null;

      syncingSelectionRef.current = true;
      model.closeSearch();
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
  }, [loadDirectory, model, selectedPath, selectedPathRevealId]);

  // Tag tree drags with the composer mention payload. The row is read from
  // the composed event path (the tree's shadow root is open), so this does
  // not depend on running after the tree's own dragstart handler; the drag
  // data store is writable for every dragstart listener in the dispatch.
  // The capture phase runs before the tree's own dragstart handler selects
  // the dragged row, so the drag flag is up before that selection emits.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    treeModelRef.current = model;
  }, [model]);
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    const handleDragStart = (event: DragEvent) => dragMention.handleDragStart(event);
    const handleDragEnd = () => dragMention.handleDragEnd();
    panel.addEventListener("dragstart", handleDragStart, true);
    panel.addEventListener("dragend", handleDragEnd);
    return () => {
      panel.removeEventListener("dragstart", handleDragStart, true);
      panel.removeEventListener("dragend", handleDragEnd);
    };
  }, [dragMention]);

  return (
    <div
      ref={panelRef}
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
    >
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <RefreshFilesButton isPending={rootQuery.isPending} onRefresh={handleRefresh} />
        <FileSearchField
          name="project-files-search"
          ariaLabel={`Search ${projectName} files`}
          value={search.value}
          onValueChange={handleSearchValueChange}
          onClose={search.close}
        />
      </div>
      {rootQuery.error && rootQuery.data === null ? (
        <div className="p-4 text-xs leading-relaxed text-destructive">{rootQuery.error}</div>
      ) : (
        <FileTree
          model={model}
          aria-label={`${projectName} files`}
          className="min-h-0 flex-1 overflow-hidden"
          style={{
            colorScheme: resolvedTheme,
            ["--trees-fg-override" as string]: "var(--foreground)",
          }}
        />
      )}
    </div>
  );
}
