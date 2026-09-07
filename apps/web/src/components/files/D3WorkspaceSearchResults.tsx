import type { ProjectEntry } from "@t3tools/contracts";

import { PierreEntryIcon } from "../chat/PierreEntryIcon";

/**
 * The workspace index reads a large workspace in the background, so a search
 * that lands mid-scan is answered from part of the workspace. Saying how much
 * has been read is the difference between "no matches" and "no matches yet".
 */
export function IndexingNotice(props: { scannedFiles: number }) {
  return (
    <div className="px-3 py-2 text-xs leading-relaxed text-muted-foreground">
      {`Still indexing this workspace. ${props.scannedFiles.toLocaleString()} files so far, and results improve as it reads.`}
    </div>
  );
}

/**
 * Search results replace the tree rather than filtering it. The tree holds
 * only the directories the user has opened, so a match anywhere else has no
 * row to reveal, and the server returns results in its own ranked order that a
 * tree would sort away.
 */
export function WorkspaceSearchResults(props: {
  entries: readonly ProjectEntry[];
  error: string | null;
  isPending: boolean;
  onOpenEntry: (entry: ProjectEntry) => void;
  theme: "light" | "dark";
}) {
  if (props.error) {
    return <div className="p-4 text-xs leading-relaxed text-destructive">{props.error}</div>;
  }
  if (props.entries.length === 0) {
    return (
      <div className="p-4 text-xs leading-relaxed text-muted-foreground">
        {props.isPending ? "Searching workspace…" : "No matching files."}
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-1">
      {props.entries.map((entry) => (
        <button
          key={`${entry.kind}:${entry.path}`}
          type="button"
          className="flex w-full items-center gap-1.5 rounded-[5px] px-1.5 py-1 text-left text-xs hover:bg-accent/60"
          onClick={() => props.onOpenEntry(entry)}
        >
          <PierreEntryIcon pathValue={entry.path} kind={entry.kind} theme={props.theme} />
          <span className="min-w-0 flex-1 truncate text-foreground">{entry.path}</span>
        </button>
      ))}
    </div>
  );
}
