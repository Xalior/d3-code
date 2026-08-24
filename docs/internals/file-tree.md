# File tree

> For maintainers. Using T3 Code? See [docs/user](../user/).

The file tree reads a workspace one directory at a time, on web and on mobile. It asks the server
for the workspace root when it opens, then for each directory as the user expands it. Nothing scans
the whole workspace, so opening the tree costs the same on a small repository and a huge one.

The two clients share the contract, the server, and the `listDirectory` query atom family in
`packages/client-runtime`. Above that they differ, because they get expansion from different places:
the web panel reads it back from a tree widget it does not own, and mobile holds it in state.

## Two ways to list a workspace

The server offers two project listings and they are not interchangeable.

`projects.listEntries` returns every entry in the workspace. It is served by
[`WorkspaceSearchIndex.ts`][index], which scans the tree once per workspace and respects ignore
rules. It answers "what exists anywhere in this workspace", which is what the `@` mention picker
and content search need. The cost is the whole workspace on every caller, and past its entry cap the
answer is incomplete.

`projects.listDirectory` returns the immediate children of one directory and nothing below them. It
never touches the index: [`WorkspaceEntries.listDirectory`][entries] resolves the path inside the
workspace root and reads that one directory. An empty `relativePath` addresses the workspace root.

Both are declared in [`project.ts`][project] and wired into the RPC group in [`rpc.ts`][rpc], with
scopes in [`RpcAuthorization.ts`][authz] and handlers in [`ws.ts`][ws].

## What a directory read reports

`readdir` describes a symlink as a link rather than as whatever it points at, so `listDirectory`
follows each link with `stat` and reports it as a directory when the target is one. Workspaces that
share a directory across sibling checkouts are built out of these, and a tree that cannot open them
hides most of the content. A link with no target, or one that cannot be read, stays a leaf rather
than failing the directory around it.

A link back to an ancestor makes a cycle the user can walk downwards. One directory is read per
expansion, so the cost is bounded by what the user opens by hand, which is the same bound a deep
tree already has.

A directory the account may not read lists as empty. Blanking the panel over one unreadable
directory would be worse than showing an empty branch.

## Web: paging the tree in

[`FileBrowserPanel.tsx`][panel] holds a `@pierre/trees` model and grows it. The workspace root's
children seed the tree; every directory below arrives through `loadProjectDirectory` in
[`projectFilesQueryState.ts`][queries], which drives the `listDirectory` query atom family outside
React's render cycle. Which directories the panel needs depends on what the user clicks, so they are
not knowable from hook order.

The panel keeps its own picture of the workspace in refs, because that picture grows between renders
rather than being derived from one: which entries are files, which directories have been read, the
child directories of each of those, which directories the tree holds open, and which reads are in
flight. Two callers racing for the same directory share one request.

## Web: watching for expansion

`@pierre/trees` deliberately drops expand and collapse from `onMutation`, so nothing announces that
a directory was opened. The panel reads the tree back instead.

`model.subscribe()` fires on every controller notification, selection changes included. Each
notification schedules at most one walk on the next animation frame, so a burst costs a single pass.

That pass is `walkOpenDirectories` in [`fileTreeDirectories.ts`][directories]. It starts at the
workspace root, descends only through directories the tree holds open, and stops at every closed
one. It reports the open directories, the closed ones, and the open directories whose listing has
not arrived yet. The panel reads those last, and records the open set for the next refresh. Walking
the open part of the tree rather than every directory the panel has discovered matters because the
discovered set only grows as the user browses.

## Web: refresh

The refresh button re-reads the workspace root, which rebuilds the tree from scratch. The panel
takes the open set from the last walk first, then reopens those directories outermost first, so no
directory is read before the one holding it. `directoryRestoreOrder` leaves out any directory whose
containing directories are not reopening as well, because reopening it alone would put rows in the
tree below a directory nobody has read.

A directory can be deleted from disk between refreshes. Its read fails on its own, and that branch
drops out of the reopen while the rest of the tree stands.

## Web: revealing a file

Opening a file from outside the tree reveals it in the panel: the file picker, content search and
chat links all do this. The file may sit under directories nobody has expanded, so the panel reads
the chain of containing directories first, then expands them and selects the row. A selection that
came from the tree itself is already visible and is left alone, so revealing it again cannot scroll
the tree out from under the user.

Search results stand in front of the tree, so a reveal that arrives while they are up waits. It runs
when the results are dismissed, rather than scrolling a hidden tree and taking focus off the search
field.

## Mobile: the open set is already state

Mobile draws its own tree from a flat array of entries, and the user taps a row to open a directory,
so it already knows what is open. There is nothing to read back and no walk to bound.

[`workspaceFileTree.ts`][mobiletree] holds that as one value: the listings that have arrived, keyed
by the directory each describes, and the directories the user has open. They belong together because
opening a directory is what asks for its listing, and losing a listing has to close the directory
that held it. Every change is a pure transition on that value, so the reads the tree still owes are
whatever is open with no listing.

[`useWorkspaceFileTree.ts`][mobilehook] is the thin part: it reads the workspace root through the
shared query atom, reads whatever the state says is outstanding, and folds each result back in. A
read that started before the root was re-read is dropped rather than grafted onto a tree that no
longer exists. A read that fails takes its directory and everything below it out of the state.

Refresh needs no separate path. Re-reading the root replaces the listings and leaves the open
directories alone, so those directories are simply outstanding again. Only the first reading of a
workspace opens the root's own directories, so a refresh does not reopen a tree the user closed.

`FileTreeBrowser` is given the open set, a toggle, and the current search results, and renders. It
owns no loading.

## Searching the workspace

The tree holds only the directories the user has opened, so filtering it would answer for that part
of the workspace and say nothing about the rest. The search field goes to `projects.searchEntries`
instead. Its results replace the tree rather than filter it. They come from anywhere in the
workspace, in the order the server ranked them, which a tree would sort away.

Both clients drive it through a `useWorkspaceEntrySearch` hook, [web][queries] and
[mobile][mobilequeries], over the shared `searchEntries` query atom, debounced, and asking for
files and directories alike. A file result opens in the preview and leaves the results up. A
directory result returns the user to the tree with that directory and its ancestors open.

### Searching a workspace that is still being indexed

`searchEntries` is served by the same index as `listEntries`, and a large workspace takes longer to
scan than the index gives its first scan. Missing that budget does not fail the index: the finder is
kept, the scan carries on in the background, and searches are answered from the part of the
workspace already read. Discarding it instead, as the index once did, restarted the scan from
nothing on the next search, so a workspace too large for one budget never became searchable at all.

Every `ProjectSearchEntriesResult` therefore carries an `indexStatus` of `isScanning` and
`scannedFiles`. Both clients show the figure while the scan runs, "still indexing this workspace,
N files so far", and repeat the query on a two second interval until it clears, so the result list
grows as the workspace is read. The field is optional on the wire, and a server that does not report
it leaves the clients silent rather than guessing.

[authz]: ../../apps/server/src/auth/RpcAuthorization.ts
[directories]: ../../apps/web/src/components/files/fileTreeDirectories.ts
[entries]: ../../apps/server/src/workspace/WorkspaceEntries.ts
[index]: ../../apps/server/src/workspace/WorkspaceSearchIndex.ts
[mobilehook]: ../../apps/mobile/src/features/files/useWorkspaceFileTree.ts
[mobilequeries]: ../../apps/mobile/src/state/queries.ts
[mobiletree]: ../../apps/mobile/src/features/files/workspaceFileTree.ts
[panel]: ../../apps/web/src/components/files/FileBrowserPanel.tsx
[project]: ../../packages/contracts/src/project.ts
[queries]: ../../apps/web/src/components/files/projectFilesQueryState.ts
[rpc]: ../../packages/contracts/src/rpc.ts
[ws]: ../../apps/server/src/ws.ts
