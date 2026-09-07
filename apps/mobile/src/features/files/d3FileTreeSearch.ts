import type { ProjectEntry } from "@t3tools/contracts";

import type { VisibleFileTreeNode } from "./fileTree";

/**
 * Search rows for the paged file tree.
 *
 * The tree holds only the directories the user has opened, so searching it locally would only
 * ever find what had already been read. Search is a whole-workspace query on the server, and
 * its results are their own list rather than a filter over the tree. `fileTree.ts` keeps
 * upstream's tree building and its own local search; what the fork's search needs lives here.
 */

/**
 * Turns whole-workspace search results into rows. Results come back from
 * anywhere in the workspace in the server's ranked order, so they are listed
 * flat under their full paths rather than folded into the browse tree, which
 * only holds the directories the user has opened.
 */
export function workspaceSearchResultNodes(
  entries: ReadonlyArray<ProjectEntry>,
): ReadonlyArray<VisibleFileTreeNode> {
  return entries.map((entry) => ({
    node: {
      path: entry.path,
      name: entry.path,
      kind: entry.kind,
      children: [],
      // A result row is never fed back through the tree's own search, so it
      // carries no search terms of its own.
      searchSegments: [],
      searchWords: [],
    },
    depth: 0,
  }));
}

/**
 * What the tree says when it has no rows. A search that has not answered yet
 * must not be reported as a search that found nothing.
 */
export function fileTreeEmptyState(input: {
  readonly searchQuery: string;
  readonly searchError: string | null;
  readonly searchIsPending: boolean;
}): { readonly title: string; readonly detail: string | null } {
  if (input.searchQuery.trim().length === 0) {
    return { title: "No files found", detail: "This workspace has no files." };
  }
  if (input.searchError !== null) {
    return { title: "Search unavailable", detail: input.searchError };
  }
  if (input.searchIsPending) {
    return { title: "Searching the workspace…", detail: null };
  }
  return { title: "No matching files", detail: "Try a different search." };
}
