/** Полоса вкладок панели. */

import type { Dict } from "../i18n";
import type { TabState } from "../types";

type Props = {
  t: Dict;
  tabs: TabState[];
  activeTabId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
};

const tabLabel = (tab: TabState): string => {
  const p = tab.listing?.path ?? tab.history[tab.history.length - 1] ?? "";
  if (!p) return "…";
  return p.slice(p.lastIndexOf("/") + 1) || "/";
};

export function TabStrip({ t, tabs, activeTabId, onSelect, onClose, onNew }: Props) {
  return (
    <div className="tab-strip">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={"tab" + (tab.id === activeTabId ? " active" : "")}
          onClick={() => onSelect(tab.id)}
          title={tab.listing?.path ?? ""}
        >
          <span className="tab-name">{tabLabel(tab)}</span>
          {tabs.length > 1 && (
            <button
              className="tab-close"
              title={t.closeTab}
              onClick={(ev) => {
                ev.stopPropagation();
                onClose(tab.id);
              }}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <button className="tab-new" onClick={onNew} title={t.newTab}>
        +
      </button>
    </div>
  );
}
