import type { ProjectEntry } from "@t3tools/contracts";

export interface FileTreeNode {
  readonly path: string;
  readonly name: string;
  readonly kind: ProjectEntry["kind"];
  readonly children: ReadonlyArray<FileTreeNode>;
}

export interface VisibleFileTreeNode {
  readonly node: FileTreeNode;
  readonly depth: number;
}

interface MutableFileTreeNode {
  path: string;
  name: string;
  kind: ProjectEntry["kind"];
  children: Map<string, MutableFileTreeNode>;
}

function createMutableNode(
  path: string,
  name: string,
  kind: ProjectEntry["kind"],
): MutableFileTreeNode {
  return {
    path,
    name,
    kind,
    children: new Map(),
  };
}

function freezeNode(node: MutableFileTreeNode): FileTreeNode {
  return {
    path: node.path,
    name: node.name,
    kind: node.kind,
    children: [...node.children.values()].sort(compareNodes).map(freezeNode),
  };
}

function compareNodes(
  left: Pick<FileTreeNode, "kind" | "name">,
  right: Pick<FileTreeNode, "kind" | "name">,
): number {
  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

export function buildFileTree(entries: ReadonlyArray<ProjectEntry>): ReadonlyArray<FileTreeNode> {
  const root = createMutableNode("", "", "directory");

  for (const entry of entries) {
    const parts = entry.path.split("/").filter(Boolean);
    if (parts.length === 0) {
      continue;
    }

    let current = root;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (!part) {
        continue;
      }

      const path = parts.slice(0, index + 1).join("/");
      const isLeaf = index === parts.length - 1;
      const kind = isLeaf ? entry.kind : "directory";
      let child = current.children.get(part);
      if (!child) {
        child = createMutableNode(path, part, kind);
        current.children.set(part, child);
      } else if (isLeaf) {
        child.kind = entry.kind;
      }
      current = child;
    }
  }

  return [...root.children.values()].sort(compareNodes).map(freezeNode);
}

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
    node: { path: entry.path, name: entry.path, kind: entry.kind, children: [] },
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

export function countFileNodes(nodes: ReadonlyArray<FileTreeNode>): number {
  let count = 0;
  for (const node of nodes) {
    if (node.kind === "file") {
      count += 1;
    } else {
      count += countFileNodes(node.children);
    }
  }
  return count;
}

function flattenNode(
  output: VisibleFileTreeNode[],
  node: FileTreeNode,
  depth: number,
  expanded: ReadonlySet<string>,
): void {
  output.push({ node, depth });
  if (node.kind !== "directory" || !expanded.has(node.path)) return;
  for (const child of node.children) {
    flattenNode(output, child, depth + 1, expanded);
  }
}

/** The rows of the browse tree: the root's children, plus everything below an open directory. */
export function flattenFileTree(input: {
  readonly nodes: ReadonlyArray<FileTreeNode>;
  readonly expanded: ReadonlySet<string>;
}): ReadonlyArray<VisibleFileTreeNode> {
  const output: VisibleFileTreeNode[] = [];
  for (const node of input.nodes) {
    flattenNode(output, node, 0, input.expanded);
  }
  return output;
}

export function firstFilePath(nodes: ReadonlyArray<FileTreeNode>): string | null {
  for (const node of nodes) {
    if (node.kind === "file") {
      return node.path;
    }
    const child = firstFilePath(node.children);
    if (child !== null) {
      return child;
    }
  }
  return null;
}
