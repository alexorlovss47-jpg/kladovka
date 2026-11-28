/** Список файлов: шапка с сортировкой и строки. */

import type { Dict } from "../i18n";
import { fmtDate, fmtSizeWith, iconFor } from "../format";
import type { Entry, SortDir, SortKey } from "../types";

type Props = {
  t: Dict;
  entries: Entry[];
  selection: Set<string>;
  renaming: string | null;
  renameValue: string;
  loading: boolean;
  error: string | null;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  onClickEntry: (e: Entry, ev: React.MouseEvent) => void;
  onOpenEntry: (e: Entry) => void;
  onContextEntry: (e: Entry) => void;
  onRenameValue: (v: string) => void;
  onCommitRename: (path: string, name: string) => void;
  onCancelRename: () => void;
  onEmptyClick: (ev: React.MouseEvent) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
};

export function FileList({
  t,
  entries,
  selection,
  renaming,
  renameValue,
  loading,
  error,
  sortKey,
  sortDir,
  onSort,
  onClickEntry,
  onOpenEntry,
  onContextEntry,
  onRenameValue,
  onCommitRename,
  onCancelRename,
  onEmptyClick,
  listRef,
}: Props) {
  const fmtSize = fmtSizeWith(t);
  const arrow = (k: SortKey) =>
    sortKey === k ? <span className="th-arrow">{sortDir === 1 ? "▲" : "▼"}</span> : null;

  return (
    <>
      <div className="list-head">
        <span style={{ width: 28 }} />
        <span
          className={"th" + (sortKey === "name" ? " sorted" : "")}
          style={{ flex: 1 }}
          onClick={() => onSort("name")}
        >
          {t.colName}
          {arrow("name")}
        </span>
        <span
          className={"th" + (sortKey === "size" ? " sorted" : "")}
          style={{ width: 110, textAlign: "right" }}
          onClick={() => onSort("size")}
        >
          {t.colSize}
          {arrow("size")}
        </span>
        <span
          className={"th" + (sortKey === "date" ? " sorted" : "")}
          style={{ width: 150, textAlign: "right" }}
          onClick={() => onSort("date")}
        >
          {t.colModified}
          {arrow("date")}
        </span>
      </div>

      <div className="list" ref={listRef} onClick={onEmptyClick}>
        {loading && <div className="loading">{t.loading}</div>}
        {!loading && entries.length === 0 && !error && <div className="empty">{t.empty}</div>}
        {entries.map((e) => (
          <div
            key={e.path}
            className={
              "row" +
              (selection.has(e.path) ? " selected" : "") +
              (e.is_dir ? " dir" : "") +
              (e.is_hidden ? " hidden" : "")
            }
            onClick={(ev) => {
              if (renaming === e.path) return;
              onClickEntry(e, ev);
            }}
            onDoubleClick={() => onOpenEntry(e)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              onContextEntry(e);
            }}
          >
            <span className="ico">{iconFor(e)}</span>
            {renaming === e.path ? (
              <input
                className="rename-input"
                autoFocus
                value={renameValue}
                onChange={(ev) => onRenameValue(ev.target.value)}
                onBlur={onCancelRename}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") onCommitRename(e.path, renameValue);
                  if (ev.key === "Escape") onCancelRename();
                }}
              />
            ) : (
              <span className="name">
                {e.name}
                {e.is_symlink ? <span className="sym">→</span> : null}
              </span>
            )}
            <span className="size">{e.is_dir ? "—" : fmtSize(e.size)}</span>
            <span className="date">{fmtDate(e.modified)}</span>
          </div>
        ))}
      </div>
    </>
  );
}
