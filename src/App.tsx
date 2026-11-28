import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { dict, resolveLang, type Lang, type Dict } from "./i18n";
import { loadSoundSettings, playSound, type SoundSettings } from "./sounds";
import { usePanels } from "./hooks/usePanels";
import { useFileOperations } from "./hooks/useFileOperations";
import { useOperations } from "./hooks/useOperations";
import { useFavorites, usePrefs } from "./hooks/useFavorites";
import { useKeymap, prettyCombo, eventToCombo } from "./hooks/useKeymap";
import { Sidebar } from "./components/Sidebar";
import { Panel } from "./components/Panel";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { KeymapModal } from "./components/KeymapModal";
import { SettingsModal } from "./components/SettingsModal";
import { CreateDialog } from "./components/CreateDialog";
import { ConflictDialog } from "./components/ConflictDialog";
import { OperationsPanel } from "./components/OperationsPanel";
import { ContextMenu, type MenuTarget } from "./components/ContextMenu";
import type {
  ActionName,
  ClipboardState,
  DiskInfo,
  Entry,
  ThemePref,
} from "./types";
import "./App.css";

/** Контекстное меню: где и для чего открыто. */
type MenuState = { x: number; y: number; panelId: string; target: MenuTarget } | null;

export default function App() {
  // ---------- настройки ----------
  const [langPref, setLangPref] = useState<Lang | "auto">(
    () => (localStorage.getItem("kladovka-lang") as Lang | "auto") || "auto",
  );
  const [themePref, setThemePref] = useState<ThemePref>(
    () => (localStorage.getItem("kladovka-theme") as ThemePref) || "auto",
  );
  const [soundSettings, setSoundSettings] = useState<SoundSettings>(() => loadSoundSettings());
  const lang: Lang = resolveLang(langPref);
  const t: Dict = dict[lang];

  const { prefs, update: updatePrefs } = usePrefs();
  const [home, setHome] = useState<string | null>(null);
  const [places, setPlaces] = useState<DiskInfo[]>([]);
  const [disks, setDisks] = useState<DiskInfo[]>([]);
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [newMenuPane, setNewMenuPane] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showKeymap, setShowKeymap] = useState(false);
  const [dropActive, setDropActive] = useState(false);

  const keymap = useKeymap();
  const favs = useFavorites();
  const api = usePanels(prefs.showHidden, home);

  // Активная панель и её срез.
  const activeId = api.activePanelId;
  const { tab: activeTab, entries: activeEntries } = api.slice(activeId);

  // ---------- операции ----------
  const doRefreshAll = useCallback(() => api.refreshAll(), [api]);

  const ops = useFileOperations({
    sounds: soundSettings,
    currentPath: activeTab?.listing?.path,
    entries: activeEntries,
    refresh: doRefreshAll,
    setError: (msg) => api.setError(activeId, msg),
    clearClipboard: () => setClipboard(null),
  });

  const operations = useOperations({ sounds: soundSettings, onFinished: doRefreshAll });

  // ---------- окружение ----------
  useEffect(() => {
    (async () => {
      const injected = (window as unknown as { __KLADOVKA_START_PATH__?: string })
        .__KLADOVKA_START_PATH__;
      const h = injected ?? (await invoke<string>("home_dir"));
      setHome(h);
      setPlaces(await invoke<DiskInfo[]>("special_dirs"));
      setDisks(await invoke<DiskInfo[]>("disk_info"));
    })();
  }, []);

  useEffect(() => {
    let alive = true;
    const sync = async () => {
      try {
        const next = await invoke<DiskInfo[]>("disk_info");
        if (!alive) return;
        setDisks((prev) => {
          const key = (x: DiskInfo[]) => x.map((d) => `${d.mount}:${d.total}`).join("|");
          return key(prev) === key(next) ? prev : next;
        });
      } catch {
        /* диск могли отключить в момент чтения */
      }
    };
    const timer = window.setInterval(sync, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // Тема.
  useEffect(() => {
    const root = document.documentElement;
    if (themePref === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", themePref);
  }, [themePref]);

  // Приём файлов из Finder.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((ev) => {
        const p = ev.payload;
        if (p.type === "enter") {
          setDropActive(true);
        } else if (p.type === "leave") {
          setDropActive(false);
        } else if (p.type === "drop") {
          setDropActive(false);
          const dest = activeTab?.listing?.path;
          if (!p.paths.length || !dest) return;
          const sources = p.paths.filter((s) => s.slice(0, s.lastIndexOf("/")) !== dest);
          if (!sources.length) return;
          playSound("drop", soundSettings);
          void ops.runTransfer("copy", sources, dest, "rename");
        }
      })
      .then((f) => {
        if (cancelled) f();
        else unlisten = f;
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [activeTab?.listing?.path, ops, soundSettings]);

  // ---------- действия ----------
  const openEntry = useCallback(
    (e: Entry) => {
      if (e.is_dir) {
        playSound("select", soundSettings);
        api.go(activeId, e.path);
      } else {
        invoke("open_path", { path: e.path }).catch((err) => api.setError(activeId, String(err)));
      }
    },
    [api, activeId, soundSettings],
  );

  const doNewWindow = useCallback(async (path?: string) => {
    try {
      await invoke<string>("new_window", { path: path ?? null });
    } catch (e) {
      console.error(e);
    }
  }, []);

  const activeSelection = activeTab?.selection ?? new Set<string>();
  const singleSelection = activeSelection.size === 1 ? [...activeSelection][0] : null;

  const startRenameOf = useCallback(() => {
    if (!singleSelection) return;
    const e = activeEntries.find((x) => x.path === singleSelection);
    if (e) ops.startRename(e);
  }, [singleSelection, activeEntries, ops]);

  const trashSelection = useCallback(() => {
    const paths = [...activeSelection];
    void ops.trash(paths);
  }, [activeSelection, ops]);

  // ---------- хоткеи ----------
  const actions = useMemo<Record<ActionName, () => void>>(
    () => ({
      newTab: () => api.addTab(activeId, activeTab?.listing?.path),
      closeTab: () => activeTab && api.closeTab(activeId, activeTab.id),
      nextTab: () => api.cycleTab(activeId, 1),
      prevTab: () => api.cycleTab(activeId, -1),
      focusOtherPane: () => api.focusOtherPane(),
      toggleDualPane: () => api.toggleDualPane(),
      newWindow: () => void doNewWindow(activeTab?.listing?.path),
      newFolder: () => ops.setDialog({ kind: "dir", value: t.defaultFolderName }),
      goUp: () => api.goUp(activeId),
      goBack: () => api.goBack(activeId),
      goForward: () => api.goForward(activeId),
      openEntry: () => {
        if (!activeTab?.anchor) return;
        const e = activeEntries.find((x) => x.path === activeTab.anchor);
        if (e) openEntry(e);
      },
      rename: startRenameOf,
      trash: trashSelection,
      selectAll: () => api.setSelection(activeId, new Set(activeEntries.map((e) => e.path))),
      copy: () => {
        if (activeSelection.size) setClipboard({ mode: "copy", paths: [...activeSelection] });
      },
      cut: () => {
        if (activeSelection.size) setClipboard({ mode: "cut", paths: [...activeSelection] });
      },
      paste: () => void ops.paste(clipboard),
      focusSearch: () =>
        document.querySelector<HTMLInputElement>(`.pane.active .search`)?.focus(),
      help: () => setShowShortcuts((v) => !v),
      refresh: () => api.refresh(activeId),
      toggleHidden: () => updatePrefs({ showHidden: !prefs.showHidden }),
    }),
    [
      api,
      activeId,
      activeTab,
      activeEntries,
      activeSelection,
      clipboard,
      ops,
      t,
      doNewWindow,
      openEntry,
      startRenameOf,
      trashSelection,
      prefs.showHidden,
      updatePrefs,
    ],
  );

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;

      // Навигация стрелками не настраивается: она контекстна.
      if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
        ev.preventDefault();
        if (!activeEntries.length) return;
        const paths = activeEntries.map((e) => e.path);
        let idx = activeTab?.anchor ? paths.indexOf(activeTab.anchor) : -1;
        idx = ev.key === "ArrowDown" ? Math.min(idx + 1, paths.length - 1) : Math.max(idx - 1, 0);
        api.setSelection(activeId, new Set([paths[idx]]), paths[idx]);
        return;
      }
      if (ev.key === "Escape") {
        setMenu(null);
        api.clearSelection(activeId);
        return;
      }

      const combo = eventToCombo(ev);
      if (!combo) return;
      const action = keymap.actionFor(combo);
      if (!action) return;
      ev.preventDefault();
      actions[action]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, api, activeId, activeEntries, activeTab, keymap]);

  // ---------- контекстное меню ----------
  const openMenuFor = useCallback(
    (panelId: string, target: MenuTarget, ev: React.MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      api.setActivePanelId(panelId);
      setMenu({ x: ev.clientX, y: ev.clientY, panelId, target });
    },
    [],
  );

  const targetPath = menu?.target.kind === "entry" ? menu.target.path : null;
  const isFavTarget = !!targetPath && favs.isFavorite(targetPath);
  // Панель, на которой открыто меню: selection/entries берём от неё, а не от
  // активной — setState из клика ещё не применился в этом рендере.
  const menuSlice = menu ? api.slice(menu.panelId) : null;
  const menuSelection = menuSlice?.tab?.selection ?? new Set<string>();
  const menuSingle = menuSelection.size === 1 ? [...menuSelection][0] : null;

  // ---------- панели ----------
  const paneIds = api.panels.map((p) => p.id);
  const currentPath = activeTab?.listing?.path;

  return (
    <div className={"fm" + (api.dualPane ? " dual" : "")}>
      <Sidebar
        places={places}
        disks={disks}
        favorites={favs.favorites}
        currentPath={currentPath}
        t={t}
        onGo={(path) => api.go(activeId, path)}
        onRemoveFavorite={favs.removeFavorite}
      />

      <main className="main">
        <div className="panes">
        {paneIds.map((pid) => {
          const { panel, tab, entries } = api.slice(pid);
          if (!panel || !tab) return null;
          const paneActive = pid === activeId;
          return (
            <Panel
              key={pid}
              t={t}
              panel={panel}
              tab={tab}
              entries={entries}
              active={paneActive}
              viewMode={prefs.viewMode}
              showHidden={prefs.showHidden}
              newMenu={newMenuPane === pid}
              clipboard={clipboard}
              renaming={ops.renaming}
              renameValue={ops.renameValue}
              onFocus={() => api.setActivePanelId(pid)}
              onSelectTab={(id) => api.selectTab(pid, id)}
              onCloseTab={(id) => api.closeTab(pid, id)}
              onNewTab={() => api.addTab(pid, tab.listing?.path)}
              onBack={() => api.goBack(pid)}
              onForward={() => api.goForward(pid)}
              onUp={() => api.goUp(pid)}
              onGo={(path) => api.go(pid, path)}
              onQueryChange={(v) => api.setQuery(pid, v)}
              onSearch={() => void api.search(pid, tab.query)}
              onClearSearch={() => {
                api.setQuery(pid, "");
                void api.search(pid, "");
              }}
              onToggleNewMenu={() => setNewMenuPane((cur) => (cur === pid ? null : pid))}
              onNewFolder={() => {
                setNewMenuPane(null);
                api.setActivePanelId(pid);
                ops.setDialog({ kind: "dir", value: t.defaultFolderName });
              }}
              onNewFile={(ext) => {
                setNewMenuPane(null);
                api.setActivePanelId(pid);
                ops.setDialog({
                  kind: "file",
                  value: ext ? `${t.defaultFileName}.${ext}` : `${t.defaultFileName}.txt`,
                });
              }}
              onToggleHidden={() => updatePrefs({ showHidden: !prefs.showHidden })}
              onRefresh={() => api.refresh(pid)}
              onOpenSettings={() => setShowSettings(true)}
              onOpenShortcuts={() => setShowShortcuts(true)}
              onSort={(k) => api.setSort(pid, k)}
              onClickEntry={(e, ev, list) => api.clickEntry(pid, e, ev, list)}
              onOpenEntry={(e) => {
                api.setActivePanelId(pid);
                openEntry(e);
              }}
              onContextEntry={(e, ev) => {
                if (!tab.selection.has(e.path)) {
                  api.setSelection(pid, new Set([e.path]), e.path);
                }
                openMenuFor(pid, { kind: "entry", path: e.path, isDir: e.is_dir }, ev);
              }}
              onContextEmpty={(ev) => openMenuFor(pid, { kind: "empty" }, ev)}
              onRenameValue={ops.setRenameValue}
              onCommitRename={(p, name) => void ops.rename(p, name)}
              onCancelRename={() => ops.setRenaming(null)}
              onClearSelection={() => api.clearSelection(pid)}
              onClearError={() => api.setError(pid, null)}
              onCopy={() => setClipboard({ mode: "copy", paths: [...tab.selection] })}
              onCut={() => setClipboard({ mode: "cut", paths: [...tab.selection] })}
              onTrash={() => void ops.trash([...tab.selection])}
              onRename={() => {
                const sel = [...tab.selection];
                if (sel.length !== 1) return;
                const e = entries.find((x) => x.path === sel[0]);
                if (e) ops.startRename(e);
              }}
              onReveal={() => {
                const sel = [...tab.selection];
                if (sel.length === 1) void invoke("reveal_path", { path: sel[0] });
              }}
              onPaste={() => void ops.paste(clipboard)}
            />
          );
        })}
        </div>

        {dropActive && (
          <div className="drop-overlay">
            <div className="drop-card">{t.dropHint}</div>
          </div>
        )}

        <OperationsPanel
          t={t}
          active={operations.active}
          finished={operations.finished}
          onPause={operations.pause}
          onResume={operations.resume}
          onCancel={operations.cancel}
          onDismiss={operations.dismiss}
        />

        <div className="bottom-hint">
          <span className="bh-item">
            <kbd>↑↓</kbd> {t.scUp}
          </span>
          <span className="bh-item">
            <kbd>{prettyCombo(keymap.keys.newTab)}</kbd> {t.newTab}
          </span>
          <span className="bh-item">
            <kbd>{prettyCombo(keymap.keys.trash)}</kbd> {t.scTrash}
          </span>
          <span className="bh-item">
            <kbd>{prettyCombo(keymap.keys.help)}</kbd> {t.scHelp}
          </span>
          <button className="bh-link" onClick={() => setShowKeymap(true)}>
            {t.shortcutsConfig}
          </button>
        </div>

        {menu && (
          <ContextMenu
            t={t}
            x={menu.x}
            y={menu.y}
            target={menu.target}
            selectionSize={menuSelection.size}
            clipboard={clipboard}
            isFavorite={isFavTarget}
            dualPane={api.dualPane}
            onClose={() => setMenu(null)}
            onOpen={() => {
              if (targetPath) {
                const e = menuSlice?.entries.find((x) => x.path === targetPath);
                if (e) openEntry(e);
              }
            }}
            onReveal={() => targetPath && void invoke("reveal_path", { path: targetPath })}
            onRename={() => {
              if (!menuSingle) return;
              const e = menuSlice?.entries.find((x) => x.path === menuSingle);
              if (e) ops.startRename(e);
            }}
            onTrash={() => void ops.trash([...menuSelection])}
            onCopy={() => setClipboard({ mode: "copy", paths: [...menuSelection] })}
            onCut={() => setClipboard({ mode: "cut", paths: [...menuSelection] })}
            onPaste={() => void ops.paste(clipboard)}
            onNewFolder={() => ops.setDialog({ kind: "dir", value: t.defaultFolderName })}
            onNewFile={() =>
              ops.setDialog({ kind: "file", value: `${t.defaultFileName}.txt` })
            }
            onRefresh={() => api.refresh(activeId)}
            onToggleFavorite={() => {
              if (!targetPath) return;
              if (isFavTarget) favs.removeFavorite(targetPath);
              else favs.addFavorite(targetPath);
            }}
            onOpenInOtherPane={() => {
              if (!targetPath) return;
              const other = api.panels.find((p) => p.id !== activeId);
              if (other) api.go(other.id, targetPath);
            }}
            onNewWindow={() => void doNewWindow(targetPath ?? currentPath)}
            onToggleHidden={() => updatePrefs({ showHidden: !prefs.showHidden })}
          />
        )}

        {showShortcuts && (
          <ShortcutsModal t={t} keys={keymap.keys} onClose={() => setShowShortcuts(false)} />
        )}

        {showKeymap && (
          <KeymapModal
            t={t}
            keys={keymap.keys}
            onSet={keymap.setBinding}
            onReset={keymap.resetBinding}
            onResetAll={keymap.resetAll}
            onClose={() => setShowKeymap(false)}
          />
        )}

        {showSettings && (
          <SettingsModal
            t={t}
            langPref={langPref}
            themePref={themePref}
            sounds={soundSettings}
            viewMode={prefs.viewMode}
            onLangChange={(v) => {
              setLangPref(v);
              localStorage.setItem("kladovka-lang", v);
            }}
            onThemeChange={(v) => {
              setThemePref(v);
              localStorage.setItem("kladovka-theme", v);
            }}
            onSoundsChange={setSoundSettings}
            onViewModeChange={(v) => updatePrefs({ viewMode: v })}
            onOpenKeymap={() => {
              setShowSettings(false);
              setShowKeymap(true);
            }}
            onClose={() => setShowSettings(false)}
          />
        )}

        {ops.conflict && (
          <ConflictDialog
            t={t}
            onChoose={(policy) => {
              const c = ops.conflict;
              ops.setConflict(null);
              if (c) void ops.runTransfer(c.mode, c.paths, c.dest, policy);
            }}
            onCancel={() => ops.setConflict(null)}
          />
        )}

        {ops.dialog && (
          <CreateDialog
            t={t}
            dialog={ops.dialog}
            onChange={ops.setDialog}
            onCommit={() => void ops.commitCreate()}
            onCancel={() => ops.setDialog(null)}
          />
        )}
      </main>
    </div>
  );
}
