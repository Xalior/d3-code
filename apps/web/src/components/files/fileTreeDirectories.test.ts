import { describe, expect, it } from "vite-plus/test";

import {
  ancestorDirectoryPaths,
  directoryRestoreOrder,
  treePath,
  walkOpenDirectories,
  type OpenDirectoryTree,
} from "./fileTreeDirectories";

interface FakeTree {
  readonly tree: OpenDirectoryTree;
  readonly probedPaths: readonly string[];
}

function fakeTree(input: {
  children: Record<string, readonly string[]>;
  expanded: readonly string[];
}): FakeTree {
  const probedPaths: string[] = [];
  const expanded = new Set(input.expanded);
  return {
    probedPaths,
    tree: {
      childDirectories: (directoryPath) => input.children[directoryPath] ?? [],
      isExpanded: (directoryPath) => {
        probedPaths.push(directoryPath);
        return expanded.has(directoryPath);
      },
      isRead: (directoryPath) => directoryPath in input.children,
    },
  };
}

describe("treePath", () => {
  it("marks directories with a trailing separator", () => {
    expect(treePath({ path: "apps/web", kind: "directory" })).toBe("apps/web/");
    expect(treePath({ path: "apps/web/index.ts", kind: "file" })).toBe("apps/web/index.ts");
  });
});

describe("ancestorDirectoryPaths", () => {
  it("lists containing directories outermost first", () => {
    expect(ancestorDirectoryPaths("apps/web/src/main.tsx")).toEqual([
      "apps",
      "apps/web",
      "apps/web/src",
    ]);
  });

  it("has nothing to list for a file at the workspace root", () => {
    expect(ancestorDirectoryPaths("README.md")).toEqual([]);
  });
});

describe("walkOpenDirectories", () => {
  it("separates open directories from closed ones and names the unread", () => {
    const { tree } = fakeTree({
      children: { "": ["apps", "docs"], apps: ["apps/web"] },
      expanded: ["apps", "apps/web"],
    });

    expect(walkOpenDirectories(tree)).toEqual({
      openPaths: ["apps", "apps/web"],
      closedPaths: ["docs"],
      // `apps/web` is open but its listing has not arrived, so the panel owes a read.
      unreadPaths: ["apps/web"],
    });
  });

  it("never looks inside a closed directory, however much lies below it", () => {
    const { tree, probedPaths } = fakeTree({
      children: {
        "": ["apps", "node_modules"],
        node_modules: ["node_modules/a", "node_modules/b"],
        apps: ["apps/web"],
      },
      expanded: ["apps"],
    });

    const walk = walkOpenDirectories(tree);

    expect(probedPaths).toEqual(["apps", "node_modules", "apps/web"]);
    expect(walk.openPaths).toEqual(["apps"]);
    expect(walk.closedPaths).toEqual(["node_modules", "apps/web"]);
  });

  it("stops when the workspace root has not been read", () => {
    const { tree } = fakeTree({ children: {}, expanded: [] });

    expect(walkOpenDirectories(tree)).toEqual({
      openPaths: [],
      closedPaths: [],
      unreadPaths: [],
    });
  });
});

describe("directoryRestoreOrder", () => {
  it("reopens containing directories before the ones they hold", () => {
    expect(directoryRestoreOrder(["apps/web/src", "apps", "apps/web", "docs"])).toEqual([
      "apps",
      "apps/web",
      "apps/web/src",
      "docs",
    ]);
  });

  it("leaves out a directory whose containing directory stays closed", () => {
    expect(directoryRestoreOrder(["apps", "apps/web/src"])).toEqual(["apps"]);
  });
});
