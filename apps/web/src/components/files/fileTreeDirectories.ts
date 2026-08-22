import type { ProjectEntry } from "@t3tools/contracts";

/** The workspace root is addressed by an empty relative path. */
export const WORKSPACE_ROOT_DIRECTORY_PATH = "";

/** Directory rows carry a trailing separator, so path lookups must use the same form. */
export function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

/** Workspace-root-relative paths of every directory containing the given path, outermost first. */
export function ancestorDirectoryPaths(relativePath: string): readonly string[] {
  const segments = relativePath.split("/").slice(0, -1);
  const ancestors: string[] = [];
  let ancestorPath = "";
  for (const segment of segments) {
    ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
    ancestors.push(ancestorPath);
  }
  return ancestors;
}

/** The three questions the walk asks about a workspace paged in one directory at a time. */
export interface OpenDirectoryTree {
  /** Child directories of a directory whose listing has arrived, empty for any other. */
  readonly childDirectories: (directoryPath: string) => readonly string[];
  readonly isExpanded: (directoryPath: string) => boolean;
  readonly isRead: (directoryPath: string) => boolean;
}

export interface OpenDirectoryWalk {
  /** Directories the tree holds open, outermost first. */
  readonly openPaths: readonly string[];
  /** Directories the tree holds closed. Their own contents are left alone. */
  readonly closedPaths: readonly string[];
  /** Open directories whose listing has not arrived yet, so the panel still owes a read. */
  readonly unreadPaths: readonly string[];
}

/**
 * Walks from the workspace root down through directories the tree holds open,
 * and stops at every closed one. The cost is the open part of the tree rather
 * than everything the panel has ever discovered, which matters because the
 * discovered set only grows as the user browses.
 */
export function walkOpenDirectories(tree: OpenDirectoryTree): OpenDirectoryWalk {
  const openPaths: string[] = [];
  const closedPaths: string[] = [];
  const unreadPaths: string[] = [];
  const pending: string[] = [WORKSPACE_ROOT_DIRECTORY_PATH];
  while (pending.length > 0) {
    const parentPath = pending.shift();
    if (parentPath === undefined) break;
    for (const directoryPath of tree.childDirectories(parentPath)) {
      if (!tree.isExpanded(directoryPath)) {
        closedPaths.push(directoryPath);
        continue;
      }
      openPaths.push(directoryPath);
      if (tree.isRead(directoryPath)) pending.push(directoryPath);
      else unreadPaths.push(directoryPath);
    }
  }
  return { openPaths, closedPaths, unreadPaths };
}

/**
 * Order in which to reopen directories after the tree is rebuilt from the
 * workspace root: outermost first, so no directory is read before the one
 * holding it. A directory whose containing directories do not reopen is left
 * out, because reopening it alone would put rows in the tree below a directory
 * nobody has read.
 */
export function directoryRestoreOrder(expandedPaths: Iterable<string>): readonly string[] {
  const expanded = new Set(expandedPaths);
  return [...expanded]
    .sort()
    .filter((directoryPath) =>
      ancestorDirectoryPaths(directoryPath).every((ancestorPath) => expanded.has(ancestorPath)),
    );
}
