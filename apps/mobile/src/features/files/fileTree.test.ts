import { describe, expect, it } from "vite-plus/test";
import type { ProjectEntry } from "@t3tools/contracts";

import {
  buildFileTree,
  countFileNodes,
  fileTreeEmptyState,
  firstFilePath,
  flattenFileTree,
  workspaceSearchResultNodes,
} from "./fileTree";

const entries = [
  { kind: "file", path: "README.md" },
  { kind: "directory", path: "src" },
  { kind: "file", path: "src/index.ts" },
  { kind: "file", path: "src/components/App.tsx" },
  { kind: "file", path: "package.json" },
] satisfies ReadonlyArray<ProjectEntry>;

describe("mobile file tree helpers", () => {
  it("builds a deterministic hierarchy with directories before files", () => {
    const tree = buildFileTree(entries);

    expect(tree.map((node) => `${node.kind}:${node.path}`)).toEqual([
      "directory:src",
      "file:package.json",
      "file:README.md",
    ]);
    expect(tree[0]?.children.map((node) => `${node.kind}:${node.path}`)).toEqual([
      "directory:src/components",
      "file:src/index.ts",
    ]);
    expect(countFileNodes(tree)).toBe(4);
    expect(firstFilePath(tree)).toBe("src/components/App.tsx");
  });

  it("flattens expanded directories and hides collapsed descendants", () => {
    const tree = buildFileTree(entries);

    expect(
      flattenFileTree({
        nodes: tree,
        expanded: new Set(["src"]),
      }).map((item) => `${item.depth}:${item.node.path}`),
    ).toEqual(["0:src", "1:src/components", "1:src/index.ts", "0:package.json", "0:README.md"]);

    expect(
      flattenFileTree({
        nodes: tree,
        expanded: new Set(),
      }).map((item) => item.node.path),
    ).toEqual(["src", "package.json", "README.md"]);
  });

  it("lists whole-workspace search results flat, under their full paths", () => {
    expect(
      workspaceSearchResultNodes([
        { kind: "file", path: "src/components/App.tsx" },
        { kind: "directory", path: "apps/web/src/components/chat" },
      ]),
    ).toEqual([
      {
        node: {
          path: "src/components/App.tsx",
          name: "src/components/App.tsx",
          kind: "file",
          children: [],
        },
        depth: 0,
      },
      {
        node: {
          path: "apps/web/src/components/chat",
          name: "apps/web/src/components/chat",
          kind: "directory",
          children: [],
        },
        depth: 0,
      },
    ]);
  });

  it("does not report a search still running as a search that found nothing", () => {
    expect(
      fileTreeEmptyState({ searchQuery: "app", searchError: null, searchIsPending: true }),
    ).toEqual({ title: "Searching the workspace…", detail: null });
    expect(
      fileTreeEmptyState({ searchQuery: "app", searchError: null, searchIsPending: false }),
    ).toEqual({ title: "No matching files", detail: "Try a different search." });
    expect(
      fileTreeEmptyState({ searchQuery: "  ", searchError: null, searchIsPending: false }),
    ).toEqual({ title: "No files found", detail: "This workspace has no files." });
    expect(
      fileTreeEmptyState({
        searchQuery: "app",
        searchError: "Environment offline",
        searchIsPending: false,
      }),
    ).toEqual({ title: "Search unavailable", detail: "Environment offline" });
  });
});
