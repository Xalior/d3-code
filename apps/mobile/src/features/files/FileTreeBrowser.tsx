import type { ProjectEntry, ProjectSearchIndexStatus } from "@t3tools/contracts";
import { SymbolView } from "../../components/AppSymbol";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { IOS_NAV_BAR_HEIGHT } from "../../lib/layoutMetrics";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import {
  buildFileTree,
  fileTreeEmptyState,
  flattenFileTree,
  workspaceSearchResultNodes,
  type FileTreeNode,
  type VisibleFileTreeNode,
} from "./fileTree";

const fileTreeCache = new WeakMap<ReadonlyArray<ProjectEntry>, ReadonlyArray<FileTreeNode>>();
const FILE_TREE_INITIAL_RENDER_COUNT = 20;
const FILE_TREE_RENDER_BATCH_SIZE = 12;
const OPTIMISTIC_SELECTION_TIMEOUT_MS = 1_000;

function cachedFileTree(entries: ReadonlyArray<ProjectEntry>): ReadonlyArray<FileTreeNode> {
  const cached = fileTreeCache.get(entries);
  if (cached !== undefined) {
    return cached;
  }
  const tree = buildFileTree(entries);
  fileTreeCache.set(entries, tree);
  return tree;
}

const FileTreeRow = memo(function FileTreeRow(props: {
  readonly item: VisibleFileTreeNode;
  readonly selected: boolean;
  readonly expanded: boolean;
  readonly iconColor: string;
  readonly onPressDirectory: (path: string) => void;
  readonly onPreviewFile?: (path: string) => void;
  readonly onPressFile: (path: string) => void;
}) {
  const { node, depth } = props.item;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={node.path}
      onPressIn={() => {
        if (node.kind === "file") {
          props.onPreviewFile?.(node.path);
        }
      }}
      onPress={() => {
        if (node.kind === "directory") {
          props.onPressDirectory(node.path);
          return;
        }
        props.onPressFile(node.path);
      }}
      className={cn(
        "mx-2 min-h-[42px] flex-row items-center gap-2 rounded-[12px] px-2 active:bg-subtle",
        props.selected && "bg-subtle-strong",
      )}
      style={{ paddingLeft: 8 + depth * 18 }}
    >
      {node.kind === "directory" ? (
        <SymbolView
          name={props.expanded ? "chevron.down" : "chevron.right"}
          size={12}
          tintColor={props.iconColor}
          type="monochrome"
        />
      ) : (
        <View className="w-3" />
      )}
      <PierreEntryIcon path={node.path} kind={node.kind} size={17} />
      <Text
        className={cn(
          "min-w-0 flex-1 text-sm leading-normal",
          props.selected
            ? "font-t3-bold text-foreground"
            : "font-t3-medium text-foreground-secondary",
        )}
        numberOfLines={1}
      >
        {node.name}
      </Text>
      {node.kind === "directory" && node.children.length > 0 ? (
        <Text className="text-2xs font-t3-medium text-foreground-tertiary">
          {node.children.length}
        </Text>
      ) : null}
    </Pressable>
  );
});

export function FileTreeBrowser(props: {
  readonly entries: ReadonlyArray<ProjectEntry>;
  /**
   * Directories the tree shows open. The workspace is read one directory at a
   * time, so whoever owns this set also owns which listings get asked for.
   */
  readonly expandedPaths: ReadonlySet<string>;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly searchQuery: string;
  /** Whole-workspace matches for the current query, in the order the server ranked them. */
  readonly searchEntries: ReadonlyArray<ProjectEntry>;
  readonly searchError: string | null;
  readonly searchIsPending: boolean;
  /** How far the workspace index has read, while it is still reading. */
  readonly searchIndexStatus: ProjectSearchIndexStatus | null;
  readonly selectedPath: string | null;
  readonly onPreviewFile?: (path: string) => void;
  readonly onRefresh: () => void;
  readonly onRevealDirectory: (path: string) => void;
  readonly onSelectFile: (path: string) => void;
  readonly onToggleDirectory: (path: string) => void;
}) {
  const [pendingSelection, setPendingSelection] = useState<{
    readonly path: string;
    readonly selectedPathAtPress: string | null;
  } | null>(null);
  const insets = useSafeAreaInsets();
  // Native transparent-header height ≈ safe-area top + nav bar (~44). Matches the
  // observed adjustedContentInset bottom (~102) seen in the native trace.
  //
  // The header overlays the list on every iOS version, so the inset is needed on
  // every iOS version. Only who applies it differs: with liquid glass the system
  // adjusts the content itself, and without it the padding below does the same
  // job by hand.
  const headerInset = insets.top + IOS_NAV_BAR_HEIGHT;
  const iconColor = String(useThemeColor("--color-icon-muted"));
  const {
    expandedPaths,
    onPreviewFile,
    onSelectFile,
    onToggleDirectory,
    selectedPath: controlledSelectedPath,
  } = props;
  const controlledSelectedPathRef = useRef(controlledSelectedPath);
  const pendingSelectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  controlledSelectedPathRef.current = controlledSelectedPath;

  const selectedPath =
    pendingSelection?.selectedPathAtPress === controlledSelectedPath
      ? pendingSelection.path
      : controlledSelectedPath;
  const isSearching = props.searchQuery.trim().length > 0;
  const tree = useMemo(() => cachedFileTree(props.entries), [props.entries]);
  // Search results replace the tree rather than filtering it: the tree holds
  // only the directories the user has opened, so a match anywhere else has no
  // row to show, and the server's ranking would be sorted away by a tree.
  const visibleNodes = useMemo(
    () =>
      isSearching
        ? workspaceSearchResultNodes(props.searchEntries)
        : flattenFileTree({ nodes: tree, expanded: expandedPaths }),
    [expandedPaths, isSearching, props.searchEntries, tree],
  );

  useEffect(
    () => () => {
      if (pendingSelectionTimeoutRef.current !== null) {
        clearTimeout(pendingSelectionTimeoutRef.current);
      }
    },
    [],
  );

  const handleSelectFile = useCallback(
    (path: string) => {
      if (pendingSelectionTimeoutRef.current !== null) {
        clearTimeout(pendingSelectionTimeoutRef.current);
      }
      setPendingSelection({
        path,
        selectedPathAtPress: controlledSelectedPathRef.current,
      });
      pendingSelectionTimeoutRef.current = setTimeout(() => {
        pendingSelectionTimeoutRef.current = null;
        setPendingSelection((current) => (current?.path === path ? null : current));
      }, OPTIMISTIC_SELECTION_TIMEOUT_MS);
      onSelectFile(path);
    },
    [onSelectFile],
  );
  // A result row is not a row of the tree, so a directory among the results
  // hands the user back to the tree with that directory open instead of
  // toggling a row they cannot see.
  const { onRevealDirectory } = props;
  const renderItem = useCallback(
    ({ item }: { readonly item: VisibleFileTreeNode }) => (
      <FileTreeRow
        item={item}
        selected={item.node.kind === "file" && item.node.path === selectedPath}
        expanded={!isSearching && expandedPaths.has(item.node.path)}
        iconColor={iconColor}
        onPressDirectory={isSearching ? onRevealDirectory : onToggleDirectory}
        onPreviewFile={onPreviewFile}
        onPressFile={handleSelectFile}
      />
    ),
    [
      expandedPaths,
      handleSelectFile,
      iconColor,
      isSearching,
      onPreviewFile,
      onRevealDirectory,
      onToggleDirectory,
      selectedPath,
    ],
  );
  const emptyState = fileTreeEmptyState({
    searchQuery: props.searchQuery,
    searchError: props.searchError,
    searchIsPending: props.searchIsPending,
  });

  if (props.error && props.entries.length === 0 && !isSearching) {
    return (
      <View className="flex-1 bg-sheet px-4 py-5">
        <Text className="text-sm font-t3-bold text-foreground">Files unavailable</Text>
        <Text className="mt-1 text-xs leading-normal text-foreground-muted">{props.error}</Text>
      </View>
    );
  }

  // SPIKE: render the FlatList as the screen's DIRECT content (no wrapping View), and
  // mirror the Home ScrollView exactly — `contentInsetAdjustmentBehavior: "automatic"`
  // with NO manual contentInset. iOS only applies the nav-bar top inset + scroll-edge
  // blur to a scroll view in the screen's primary position; a scroll view buried in
  // flex-1 Views is ignored, which is why the tree rendered under the header with no blur.
  return (
    <FlatList
      className="flex-1"
      data={visibleNodes}
      keyExtractor={(item) => item.node.path}
      contentInsetAdjustmentBehavior={NATIVE_LIQUID_GLASS_SUPPORTED ? "automatic" : "never"}
      scrollIndicatorInsets={{ top: headerInset, left: 0, right: 0, bottom: 0 }}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      initialNumToRender={FILE_TREE_INITIAL_RENDER_COUNT}
      maxToRenderPerBatch={FILE_TREE_RENDER_BATCH_SIZE}
      updateCellsBatchingPeriod={16}
      windowSize={5}
      contentContainerStyle={{
        paddingTop: NATIVE_LIQUID_GLASS_SUPPORTED ? 8 : headerInset + 8,
        paddingBottom: 8,
      }}
      refreshControl={<RefreshControl refreshing={props.isPending} onRefresh={props.onRefresh} />}
      renderItem={renderItem}
      ListHeaderComponent={
        isSearching && props.searchIndexStatus?.isScanning === true ? (
          <View className="px-4 pb-2">
            <Text className="text-xs leading-normal text-foreground-muted">
              {`Still indexing this workspace. ${props.searchIndexStatus.scannedFiles.toLocaleString()} files so far, and results improve as it reads.`}
            </Text>
          </View>
        ) : null
      }
      ListEmptyComponent={
        <View className="px-4 py-5">
          {props.isPending ? (
            <ActivityIndicator size="small" />
          ) : (
            <>
              <Text className="text-sm font-t3-bold text-foreground">{emptyState.title}</Text>
              {emptyState.detail === null ? null : (
                <Text className="mt-1 text-xs leading-normal text-foreground-muted">
                  {emptyState.detail}
                </Text>
              )}
            </>
          )}
        </View>
      }
    />
  );
}
