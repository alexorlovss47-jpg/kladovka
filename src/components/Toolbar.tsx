/** Верхняя панель: история, крошки, поиск, создание, переключатели. */

import type { Dict } from "../i18n";
import { fileTemplates } from "../format";
import type { Crumb } from "../types";

type Props = {
  t: Dict;
  crumbs: Crumb[];
  canBack: boolean;
  canForward: boolean;
  canUp: boolean;
  query: string;
  showHidden: boolean;
  newMenu: boolean;
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
};

export function Toolbar({
  t,
  crumbs,
  canBack,
  canForward,
  canUp,
  query,
  showHidden,
  newMenu,
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
}: Props) {
  const templates = fileTemplates(t);

  return (
    <div className="toolbar">
      <button className="tb" onClick={onBack} disabled={!canBack} title={t.back}>
        ←
      </button>
      <button className="tb" onClick={onForward} disabled={!canForward} title={t.forward}>
        →
      </button>
      <button className="tb" onClick={onUp} disabled={!canUp} title={t.up}>
        ↑
      </button>

      <div className="crumbs">
        {crumbs.map((c, i) => (
          <span key={c.path}>
            <button className="crumb" onClick={() => onGo(c.path)}>
              {c.label}
            </button>
            {i < crumbs.length - 1 && <span className="crumb-sep">/</span>}
          </span>
        ))}
      </div>

      <input
        className="search"
        placeholder={t.searchPlaceholder}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSearch();
          if (e.key === "Escape") onClearSearch();
        }}
      />

      <div className="new-menu-wrap">
        <button className="tb new-btn" onClick={onToggleNewMenu} title={t.create}>
          + <span className="new-caret">▾</span>
        </button>
        {newMenu && (
          <>
            <div className="menu-backdrop" onClick={onToggleNewMenu} />
            <div className="menu">
              <button className="menu-item" onClick={onNewFolder}>
                <span className="menu-ico">📁</span> {t.newFolder}
              </button>
              <div className="menu-sep" />
              <div className="menu-label">{t.newFile}</div>
              {templates.map((tpl) => (
                <button key={tpl.ext} className="menu-item" onClick={() => onNewFile(tpl.ext)}>
                  <span className="menu-ico">{tpl.icon}</span> {tpl.label}
                  <span className="menu-ext">.{tpl.ext}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <button className="tb" onClick={onToggleHidden} title={t.showHidden}>
        {showHidden ? "👁" : "🚫"}
      </button>
      <button className="tb" onClick={onRefresh} title={t.refresh}>
        ⟳
      </button>
      <button className="tb" onClick={onOpenSettings} title={t.settings}>
        ⚙
      </button>
      <button className="tb" onClick={onOpenShortcuts} title={t.shortcuts}>
        ?
      </button>
    </div>
  );
}
