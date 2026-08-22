import type { ProjectEntry } from "@t3tools/contracts";

/** The workspace root is addressed by an empty relative path. */
export const WORKSPACE_ROOT_DIRECTORY_PATH = "";

/** Listings keyed by the workspace-relative directory each one describes. */
export type DirectoryListings = ReadonlyMap<string, ReadonlyArray<ProjectEntry>>;

/**
 * What the file tree knows about a workspace read one directory at a time: the
 * listings that have arrived, and the directories the user has open. The two
 * belong together because opening a directory is what asks for its listing, and
 * losing a listing has to close the directory that held it.
 */
export interface WorkspaceFileTreeState {
  readonly listings: DirectoryListings;
  readonly expandedPaths: ReadonlySet<string>;
}

export const emptyWorkspaceFileTree: WorkspaceFileTreeState = {
  listings: new Map(),
  expandedPaths: new Set(),
};

/** Workspace-relative paths of every directory containing the given path, outermost first. */
export function ancestorDirectoryPaths(relativePath: string): ReadonlyArray<string> {
  const segments = relativePath.split("/").filter(Boolean).slice(0, -1);
  const ancestors: string[] = [];
  let ancestorPath = "";
  for (const segment of segments) {
    ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
    ancestors.push(ancestorPath);
  }
  return ancestors;
}

function isWithinDirectory(candidatePath: string, directoryPath: string): boolean {
  return candidatePath === directoryPath || candidatePath.startsWith(`${directoryPath}/`);
}

/**
 * Replaces the whole tree with a fresh reading of the workspace root, which is
 * what a refresh does. Directories the user has open stay open, so their
 * listings are asked for again. Only the first reading of a workspace opens the
 * root's own directories, so the screen starts as more than a list of folders
 * without a refresh reopening a tree the user closed.
 */
export function withRootListing(
  state: WorkspaceFileTreeState,
  rootEntries: ReadonlyArray<ProjectEntry>,
): WorkspaceFileTreeState {
  const listings = new Map([[WORKSPACE_ROOT_DIRECTORY_PATH, rootEntries]]);
  if (state.listings.size > 0) {
    return { listings, expandedPaths: state.expandedPaths };
  }
  return {
    listings,
    expandedPaths: new Set(
      rootEntries.flatMap((entry) => (entry.kind === "directory" ? [entry.path] : [])),
    ),
  };
}

export function withDirectoryListing(
  state: WorkspaceFileTreeState,
  directoryPath: string,
  entries: ReadonlyArray<ProjectEntry>,
): WorkspaceFileTreeState {
  const listings = new Map(state.listings);
  listings.set(directoryPath, entries);
  return { listings, expandedPaths: state.expandedPaths };
}

/**
 * Forgets a directory that no longer reads, along with everything below it. A
 * directory deleted between refreshes takes its own branch out of the tree
 * instead of failing the refresh around it.
 */
export function withoutDirectoryBranch(
  state: WorkspaceFileTreeState,
  directoryPath: string,
): WorkspaceFileTreeState {
  const listings = new Map(state.listings);
  for (const listedPath of state.listings.keys()) {
    if (isWithinDirectory(listedPath, directoryPath)) listings.delete(listedPath);
  }
  const expandedPaths = new Set(state.expandedPaths);
  for (const expandedPath of state.expandedPaths) {
    if (isWithinDirectory(expandedPath, directoryPath)) expandedPaths.delete(expandedPath);
  }
  return { listings, expandedPaths };
}

export function withToggledDirectory(
  state: WorkspaceFileTreeState,
  directoryPath: string,
): WorkspaceFileTreeState {
  const expandedPaths = new Set(state.expandedPaths);
  if (!expandedPaths.delete(directoryPath)) expandedPaths.add(directoryPath);
  return { listings: state.listings, expandedPaths };
}

/** Opens the directories containing a path, so a file selected elsewhere can be shown in place. */
export function withExpandedAncestors(
  state: WorkspaceFileTreeState,
  relativePath: string,
): WorkspaceFileTreeState {
  const ancestors = ancestorDirectoryPaths(relativePath);
  if (ancestors.every((ancestorPath) => state.expandedPaths.has(ancestorPath))) return state;
  const expandedPaths = new Set(state.expandedPaths);
  for (const ancestorPath of ancestors) expandedPaths.add(ancestorPath);
  return { listings: state.listings, expandedPaths };
}

/** Opens a directory and everything containing it, so one found by search can be shown in place. */
export function withExpandedDirectory(
  state: WorkspaceFileTreeState,
  directoryPath: string,
): WorkspaceFileTreeState {
  const expandedPaths = new Set(state.expandedPaths);
  for (const ancestorPath of ancestorDirectoryPaths(directoryPath)) expandedPaths.add(ancestorPath);
  expandedPaths.add(directoryPath);
  return { listings: state.listings, expandedPaths };
}

/** Every entry the tree knows about, as one array a tree builder can fold. */
export function listedEntries(state: WorkspaceFileTreeState): ReadonlyArray<ProjectEntry> {
  const entries: ProjectEntry[] = [];
  for (const listing of state.listings.values()) entries.push(...listing);
  return entries;
}

/** Open directories with no listing yet. These are the reads the tree still owes. */
export function unlistedDirectories(state: WorkspaceFileTreeState): ReadonlyArray<string> {
  const unlisted: string[] = [];
  for (const expandedPath of state.expandedPaths) {
    if (!state.listings.has(expandedPath)) unlisted.push(expandedPath);
  }
  return unlisted;
}
