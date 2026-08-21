import { describe, expect, it } from "vite-plus/test";
import type { ProjectEntry } from "@t3tools/contracts";

import {
  ancestorDirectoryPaths,
  emptyWorkspaceFileTree,
  listedEntries,
  unlistedDirectories,
  withDirectoryListing,
  withExpandedAncestors,
  withoutDirectoryBranch,
  withRootListing,
  withToggledDirectory,
  type WorkspaceFileTreeState,
} from "./workspaceFileTree";

const rootEntries: ReadonlyArray<ProjectEntry> = [
  { path: "README.md", kind: "file" },
  { path: "docs", kind: "directory" },
  { path: "src", kind: "directory" },
];

const srcEntries: ReadonlyArray<ProjectEntry> = [
  { path: "src/components", kind: "directory" },
  { path: "src/index.ts", kind: "file" },
];

function openedWorkspace(): WorkspaceFileTreeState {
  return withDirectoryListing(
    withRootListing(emptyWorkspaceFileTree, rootEntries),
    "src",
    srcEntries,
  );
}

describe("ancestorDirectoryPaths", () => {
  it("lists containing directories outermost first", () => {
    expect(ancestorDirectoryPaths("src/components/App.tsx")).toEqual(["src", "src/components"]);
  });

  it("has nothing to list for a file at the workspace root", () => {
    expect(ancestorDirectoryPaths("README.md")).toEqual([]);
  });
});

describe("withRootListing", () => {
  it("opens the root's own directories on a first read", () => {
    const state = withRootListing(emptyWorkspaceFileTree, rootEntries);

    expect([...state.expandedPaths]).toEqual(["docs", "src"]);
    expect(unlistedDirectories(state)).toEqual(["docs", "src"]);
  });

  it("keeps directories open across a refresh and asks for their listings again", () => {
    const refreshed = withRootListing(openedWorkspace(), rootEntries);

    expect([...refreshed.expandedPaths]).toEqual(["docs", "src"]);
    // The listing for `src` went with the rebuild, so the tree owes that read again.
    expect(unlistedDirectories(refreshed)).toEqual(["docs", "src"]);
  });

  it("does not reopen a tree the user closed", () => {
    const closed = withToggledDirectory(withToggledDirectory(openedWorkspace(), "docs"), "src");

    expect([...withRootListing(closed, rootEntries).expandedPaths]).toEqual([]);
  });
});

describe("withoutDirectoryBranch", () => {
  it("forgets a directory that has gone, and everything below it", () => {
    const state = withDirectoryListing(openedWorkspace(), "src/components", [
      { path: "src/components/App.tsx", kind: "file" },
    ]);

    const dropped = withoutDirectoryBranch(state, "src");

    expect([...dropped.expandedPaths]).toEqual(["docs"]);
    expect(listedEntries(dropped)).toEqual(rootEntries);
  });

  it("leaves the rest of the tree standing", () => {
    const dropped = withoutDirectoryBranch(openedWorkspace(), "docs");

    expect([...dropped.expandedPaths]).toEqual(["src"]);
    expect(listedEntries(dropped)).toEqual([...rootEntries, ...srcEntries]);
  });
});

describe("withToggledDirectory", () => {
  it("closes an open directory and reopens it without asking for the listing again", () => {
    const closed = withToggledDirectory(openedWorkspace(), "src");
    expect(closed.expandedPaths.has("src")).toBe(false);

    const reopened = withToggledDirectory(closed, "src");
    expect(reopened.expandedPaths.has("src")).toBe(true);
    expect(unlistedDirectories(reopened)).toEqual(["docs"]);
  });
});

describe("withExpandedAncestors", () => {
  it("opens the directories holding a file selected elsewhere", () => {
    const state = withExpandedAncestors(openedWorkspace(), "src/components/App.tsx");

    expect(state.expandedPaths.has("src/components")).toBe(true);
    expect(unlistedDirectories(state)).toEqual(["docs", "src/components"]);
  });

  it("leaves the tree untouched when every containing directory is already open", () => {
    const state = openedWorkspace();

    expect(withExpandedAncestors(state, "src/index.ts")).toBe(state);
  });
});
