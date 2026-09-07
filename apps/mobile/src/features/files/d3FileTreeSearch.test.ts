import { describe, expect, it } from "vite-plus/test";

import { fileTreeEmptyState, workspaceSearchResultNodes } from "./d3FileTreeSearch";

describe("mobile file tree search helpers", () => {
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
          searchSegments: [],
          searchWords: [],
        },
        depth: 0,
      },
      {
        node: {
          path: "apps/web/src/components/chat",
          name: "apps/web/src/components/chat",
          kind: "directory",
          children: [],
          searchSegments: [],
          searchWords: [],
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
