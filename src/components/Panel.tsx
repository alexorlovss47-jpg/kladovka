/** Одна панель: вкладки, тулбар, список, нижняя панель действий. */

import { useRef } from "react";
import type { Dict } from "../i18n";
import { buildCrumbs, fmtSizeWith } from "../format";
import type { ClipboardState, Entry, PanelState, TabState, ViewMode } from "../types";
import { TabStrip } from "./TabStrip";
import { Toolbar } from "./Toolbar";
import { FileList } from "./FileList";
import { ActionBar } from "./ActionBar";

type Props = {
  t: Dict;
  panel: PanelState;
  tab: TabState;
  entries: Entry[];
  active: boolean;
  viewMode: ViewMode;
  showHidden: boolean;
  newMenu: boolean;
  clipboard: ClipboardState | null;
  renaming: string | null;
  renameValue: string;
  onFocus: () => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onGo: (path: string) => void;
  onQueryChange: (v: string) => void;
  onSearch: () => void;
  onClearSearch: () => void;
  onToggleNewMenu: () => void;
  onNewFolder: () => void;
  onNewFile: (ext?: string) => void;
  onToggleHidden: () => void;
  onRefresh: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onTogglePreview: () => void;
  previewOpen: boolean;
  onSort: (k: TabState["sortKey"]) => void;
  onClickEntry: (e: Entry, ev: React.MouseEvent, list: Entry[]) => void;
  onOpenEntry: (e: Entry) => void;
  onContextEntry: (e: Entry, ev: React.MouseEvent) => void;
  onContextEmpty: (ev: React.MouseEvent) => void;
  onRenameValue: (v: string) => void;
  onCommitRename: (path: string, name: string) => void;
  onCancelRename: () => void;
  onClearSelection: () => void;
  onClearError: () => void;
  onCopy: () => void;
  onCut: () => void;
  onTrash: () => void;
  onRename: () => void;
  onReveal: () => void;
  onPaste: () => void;
};

export function Panel({
  t,
  panel,
  tab,
  entries,
  active,
  viewMode,
  showHidden,
  newMenu,
  clipboard,
  renaming,
  renameValue,
  onFocus,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onBack,
  onForward,
  onUp,
  onGo,
  onQueryChange,
  onSearch,
  onClearSearch,
  onToggleNewMenu,
  onNewFolder,
  onNewFile,
  onToggleHidden,
  onRefresh,
  onOpenSettings,
  onOpenShortcuts,
  onTogglePreview,
  previewOpen,
  onSort,
  onClickEntry,
  onOpenEntry,
  onContextEntry,
  onContextEmpty,
  onRenameValue,
  onCommitRename,
  onCancelRename,
  onClearSelection,
  onClearError,
  onCopy,
  onCut,
  onTrash,
  onRename,
  onReveal,
  onPaste,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const fmtSize = fmtSizeWith(t);

  const crumbs = buildCrumbs(tab.listing?.path);
  const selection = tab.selection;
  const totalSize = entries
    .filter((e) => selection.has(e.path) && e.size !== null)
    .reduce((s, e) => s + (e.size ?? 0), 0);

  return (
    <section
      className={"pane" + (active ? " active" : "")}
      onMouseDown={onFocus}
      onFocusCapture={onFocus}
    >
      <TabStrip
        t={t}
        tabs={panel.tabs}
        activeTabId={panel.activeTabId}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        onNew={onNewTab}
      />

      <Toolbar
        t={t}
        crumbs={crumbs}
        canBack={tab.histIdx > 0}
        canForward={tab.histIdx < tab.history.length - 1}
        canUp={!!tab.listing?.parent}
        query={tab.query}
        showHidden={showHidden}
        newMenu={newMenu}
        viewMode={viewMode}
        onBack={onBack}
        onForward={onForward}
        onUp={onUp}
        onGo={onGo}
        onQueryChange={onQueryChange}
        onSearch={onSearch}
        onClearSearch={onClearSearch}
        onToggleNewMenu={onToggleNewMenu}
        onNewFolder={onNewFolder}
        onNewFile={onNewFile}
        onToggleHidden={onToggleHidden}
        onRefresh={onRefresh}
        onOpenSettings={onOpenSettings}
        onOpenShortcuts={onOpenShortcuts}
        onTogglePreview={onTogglePreview}
        previewOpen={previewOpen}
      />

      {tab.listing && (
        <div className="path-bar">
          <span className="path-text">{tab.listing.path}</span>
          {selection.size > 0 && (
            <span className="sel-info">
              {t.selected} {selection.size}
              {totalSize > 0 ? ` · ${fmtSize(totalSize)}` : ""}
            </span>
          )}
          {tab.searchResults !== null && (
            <span className="sel-info">
              {t.found} {tab.searchResults.length}
            </span>
          )}
        </div>
      )}

      {tab.error && (
        <div className="error" onClick={onClearError}>
          {tab.error} <span className="err-x">✕</span>
        </div>
      )}

      <FileList
        t={t}
        entries={entries}
        selection={selection}
        renaming={renaming}
        renameValue={renameValue}
        loading={tab.loading}
        error={tab.error}
        sortKey={tab.sortKey}
        sortDir={tab.sortDir}
        viewMode={viewMode}
        onSort={onSort}
        onClickEntry={(e, ev) => onClickEntry(e, ev, entries)}
        onOpenEntry={onOpenEntry}
        onContextEntry={onContextEntry}
        onContextEmpty={onContextEmpty}
        onRenameValue={onRenameValue}
        onCommitRename={onCommitRename}
        onCancelRename={onCancelRename}
        onEmptyClick={(ev) => {
          if (ev.target === ev.currentTarget) onClearSelection();
        }}
        listRef={listRef}
      />

      <ActionBar
        t={t}
        selectionSize={selection.size}
        totalSize={totalSize}
        clipboard={clipboard}
        fmtSize={fmtSize}
        onCopy={onCopy}
        onCut={onCut}
        onTrash={onTrash}
        onRename={onRename}
        onReveal={onReveal}
        onPaste={onPaste}
      />
    </section>
  );
}
