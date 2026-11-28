import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { dict, resolveLang, type Lang, type Dict } from "./i18n";
import { loadSoundSettings, playSound, type SoundSettings } from "./sounds";
import {
  buildCrumbs,
  compareEntries,
  fmtSizeWith,
} from "./format";
import { useNavigation } from "./hooks/useNavigation";
import { useFileOperations } from "./hooks/useFileOperations";
import { Sidebar } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import { FileList } from "./components/FileList";
import { ActionBar } from "./components/ActionBar";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { SettingsModal } from "./components/SettingsModal";
import { CreateDialog } from "./components/CreateDialog";
import { ConflictDialog } from "./components/ConflictDialog";
import type {
  ClipboardState,
  DiskInfo,
  Entry,
  OpProgress,
  SortDir,
  SortKey,
  ThemePref,
} from "./types";
import "./App.css";

export default function App() {
  // ---------- настройки ----------
  const [langPref, setLangPref] = useState<Lang | "auto">(
    () => (localStorage.getItem("kladovka-lang") as Lang | "auto") || "auto",
  );
  const [themePref, setThemePref] = useState<ThemePref>(
    () => (localStorage.getItem("kladovka-theme") as ThemePref) || "auto",
  );
  const [soundSettings, setSoundSettings] = useState<SoundSettings>(() => loadSoundSettings());
  const [showHidden, setShowHidden] = useState(false);
  const lang: Lang = resolveLang(langPref);
  const t: Dict = dict[lang];
  const fmtSize = fmtSizeWith(t);

  // ---------- навигация ----------
  const nav = useNavigation(showHidden);
  const { listing, history, histIdx, loading, error, setError, load, refresh, go, goBack, goForward, goUp } =
    nav;

  // ---------- состояние списка ----------
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>(1);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Entry[] | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  const [progress, setProgress] = useState<OpProgress | null>(null);
  const [places, setPlaces] = useState<DiskInfo[]>([]);
  const [disks, setDisks] = useState<DiskInfo[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [newMenu, setNewMenu] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const clearClipboard = useCallback(() => setClipboard(null), []);

  // ---------- операции ----------
  const sortedEntries = useMemo(
    () => [...(searchResults ?? listing?.entries ?? [])].sort(compareEntries(sortKey, sortDir)),
    [searchResults, listing, sortKey, sortDir],
  );

  const ops = useFileOperations({
    sounds: soundSettings,
    currentPath: listing?.path,
    entries: sortedEntries,
    refresh,
    setError,
    clearClipboard,
  });
  const { renaming, setRenaming, renameValue, setRenameValue, dialog, setDialog, conflict, setConflict } =
    ops;

  // ---------- загрузка окружения ----------
  useEffect(() => {
    (async () => {
      const home = await invoke<string>("home_dir");
      setPlaces(await invoke<DiskInfo[]>("special_dirs"));
      setDisks(await invoke<DiskInfo[]>("disk_info"));
      await load(home, true);
      nav.resetHistory(home);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Внешние диски подключают во время работы — опрашиваем раз в 3 с.
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
        /* диск могли отключить в момент чтения — повторим на следующем тике */
      }
    };
    const timer = window.setInterval(sync, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // Смена фильтра скрытых файлов перечитывает каталог.
  useEffect(() => {
    if (listing) void load(listing.path, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  // Прогресс операций + звук завершения.
  useEffect(() => {
    const un = listen<OpProgress>("op-progress", (ev) => {
      setProgress(ev.payload);
      if (ev.payload.finished) {
        playSound(ev.payload.error ? "error" : ev.payload.kind === "move" ? "move" : "copy", soundSettings);
        setTimeout(() => {
          setProgress(null);
          if (!ev.payload.error) refresh();
        }, 600);
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [refresh, soundSettings]);

  // Тема: auto -> следует за системой, иначе атрибут на <html>.
  useEffect(() => {
    const root = document.documentElement;
    if (themePref === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", themePref);
  }, [themePref]);

  // Приём файлов, перетащенных из Finder.
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
          if (!p.paths.length || !listing) return;
          const dest = listing.path;
          // Файл из самой папки в эту же папку не трогаем (иначе «file 1»).
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
  }, [listing, ops, soundSettings]);

  // ---------- действия над списком ----------
  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(k);
      setSortDir(k === "name" ? 1 : -1);
    }
  };

  const clickEntry = (e: Entry, ev: React.MouseEvent) => {
    const next = new Set(ev.metaKey || ev.ctrlKey ? selection : []);
    if (ev.shiftKey && anchor) {
      const paths = sortedEntries.map((x) => x.path);
      const a = paths.indexOf(anchor);
      const b = paths.indexOf(e.path);
      if (a >= 0 && b >= 0) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(paths[i]);
      }
    } else if (next.has(e.path)) {
      next.delete(e.path);
    } else {
      next.add(e.path);
    }
    setSelection(next);
    setAnchor(e.path);
  };

  const openEntry = (e: Entry) => {
    if (e.is_dir) {
      playSound("select", soundSettings);
      go(e.path);
    } else {
      invoke("open_path", { path: e.path }).catch((err) => setError(String(err)));
    }
  };

  const doSearch = async () => {
    if (!query.trim() || !listing) {
      setSearchResults(null);
      return;
    }
    try {
      setSearchResults(await invoke<Entry[]>("search_tree", { root: listing.path, query, limit: 300 }));
    } catch (e) {
      setError(String(e));
    }
  };

  const onEmptyClick = (ev: React.MouseEvent) => {
    if (ev.target === ev.currentTarget) {
      setSelection(new Set());
      setAnchor(null);
    }
  };

  const totalSize = useMemo(() => {
    const sel = sortedEntries.filter((e) => selection.has(e.path) && e.size !== null);
    return sel.reduce((s, e) => s + (e.size ?? 0), 0);
  }, [sortedEntries, selection]);

  const crumbs = useMemo(() => buildCrumbs(listing?.path), [listing]);

  // ---------- горячие клавиши ----------
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
        ev.preventDefault();
        if (!sortedEntries.length) return;
        const paths = sortedEntries.map((e) => e.path);
        let idx = anchor ? paths.indexOf(anchor) : -1;
        idx = ev.key === "ArrowDown" ? Math.min(idx + 1, paths.length - 1) : Math.max(idx - 1, 0);
        setSelection(new Set([paths[idx]]));
        setAnchor(paths[idx]);
        return;
      }
      if (ev.key === "Enter" && anchor) {
        const e = sortedEntries.find((x) => x.path === anchor);
        if (e) openEntry(e);
        return;
      }
      if (ev.key === "Backspace") {
        ev.preventDefault();
        goUp();
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "f") {
        ev.preventDefault();
        document.querySelector<HTMLInputElement>(".search")?.focus();
        return;
      }
      if (ev.key === "Escape") {
        setSelection(new Set());
        setAnchor(null);
        return;
      }
      if (ev.key === "?" || (ev.shiftKey && ev.key === "/")) {
        ev.preventDefault();
        setShowShortcuts((v) => !v);
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "c" && selection.size) {
        setClipboard({ mode: "copy", paths: [...selection] });
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "x" && selection.size) {
        setClipboard({ mode: "cut", paths: [...selection] });
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "v") {
        void ops.paste(clipboard);
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "a") {
        ev.preventDefault();
        setSelection(new Set(sortedEntries.map((e) => e.path)));
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Backspace") {
        void ops.trash([...selection]);
        return;
      }
      if (ev.key === "F2" && anchor) {
        const e = sortedEntries.find((x) => x.path === anchor);
        if (e) ops.startRename(e);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedEntries, anchor, selection, clipboard, listing, ops, soundSettings]);

  // ---------- разметка ----------
  const singleSelection = selection.size === 1 ? [...selection][0] : null;
  const pct = progress && progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0;

  return (
    <div className="fm">
      <Sidebar places={places} disks={disks} currentPath={listing?.path} t={t} onGo={go} />

      <main className="main">
        <Toolbar
          t={t}
          crumbs={crumbs}
          canBack={histIdx > 0}
          canForward={histIdx < history.length - 1}
          canUp={!!listing?.parent}
          query={query}
          showHidden={showHidden}
          newMenu={newMenu}
          onBack={goBack}
          onForward={goForward}
          onUp={goUp}
          onGo={go}
          onQueryChange={setQuery}
          onSearch={doSearch}
          onClearSearch={() => {
            setQuery("");
            setSearchResults(null);
          }}
          onToggleNewMenu={() => setNewMenu((v) => !v)}
          onNewFolder={() => {
            setNewMenu(false);
            setDialog({ kind: "dir", value: t.defaultFolderName });
          }}
          onNewFile={(ext) => {
            setNewMenu(false);
            setDialog({
              kind: "file",
              value: ext ? `${t.defaultFileName}.${ext}` : `${t.defaultFileName}.txt`,
            });
          }}
          onToggleHidden={() => setShowHidden((v) => !v)}
          onRefresh={refresh}
          onOpenSettings={() => setShowSettings(true)}
          onOpenShortcuts={() => setShowShortcuts(true)}
        />

        {listing && (
          <div className="path-bar">
            <span className="path-text">{listing.path}</span>
            {selection.size > 0 && (
              <span className="sel-info">
                {t.selected} {selection.size}
                {totalSize > 0 ? ` · ${fmtSize(totalSize)}` : ""}
              </span>
            )}
            {searchResults !== null && (
              <span className="sel-info">
                {t.found} {searchResults.length}
              </span>
            )}
          </div>
        )}

        {error && (
          <div className="error" onClick={() => setError(null)}>
            {error} <span className="err-x">✕</span>
          </div>
        )}

        <FileList
          t={t}
          entries={sortedEntries}
          selection={selection}
          renaming={renaming}
          renameValue={renameValue}
          loading={loading}
          error={error}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={toggleSort}
          onClickEntry={clickEntry}
          onOpenEntry={openEntry}
          onContextEntry={(e) => {
            if (!selection.has(e.path)) {
              setSelection(new Set([e.path]));
              setAnchor(e.path);
            }
          }}
          onRenameValue={setRenameValue}
          onCommitRename={(p, name) => void ops.rename(p, name)}
          onCancelRename={() => setRenaming(null)}
          onEmptyClick={onEmptyClick}
          listRef={listRef}
        />

        <ActionBar
          t={t}
          selectionSize={selection.size}
          totalSize={totalSize}
          clipboard={clipboard}
          fmtSize={fmtSize}
          onCopy={() => setClipboard({ mode: "copy", paths: [...selection] })}
          onCut={() => setClipboard({ mode: "cut", paths: [...selection] })}
          onTrash={() => void ops.trash([...selection])}
          onRename={() => {
            if (!singleSelection) return;
            const e = sortedEntries.find((x) => x.path === singleSelection);
            if (e) ops.startRename(e);
          }}
          onReveal={() => {
            if (singleSelection) void invoke("reveal_path", { path: singleSelection });
          }}
          onPaste={() => void ops.paste(clipboard)}
        />

        {dropActive && (
          <div className="drop-overlay">
            <div className="drop-card">{t.dropHint}</div>
          </div>
        )}

        {progress && (
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
            <div className="progress-text">
              {progress.kind === "copy" ? t.copying : t.moving} {fmtSize(progress.done)}
              {progress.total > 0 ? ` / ${fmtSize(progress.total)}` : ""}
              {progress.current ? ` · ${progress.current}` : ""}
            </div>
          </div>
        )}

        <div className="bottom-hint">
          <span className="bh-item">
            <kbd>↑↓</kbd> {t.scUp}
          </span>
          <span className="bh-item">
            <kbd>{t.scAddKey}</kbd> {t.scAdd}
          </span>
          <span className="bh-item">
            <kbd>{t.scRangeKey}</kbd> {t.scRange}
          </span>
          <span className="bh-item">
            <kbd>⌘A</kbd> {t.scAll}
          </span>
          <span className="bh-item">
            <kbd>⌘⌫</kbd> {t.scTrash}
          </span>
          <span className="bh-item">
            <kbd>?</kbd> {t.scHelp}
          </span>
        </div>

        {showShortcuts && <ShortcutsModal t={t} onClose={() => setShowShortcuts(false)} />}

        {showSettings && (
          <SettingsModal
            t={t}
            langPref={langPref}
            themePref={themePref}
            sounds={soundSettings}
            onLangChange={(v) => {
              setLangPref(v);
              localStorage.setItem("kladovka-lang", v);
            }}
            onThemeChange={(v) => {
              setThemePref(v);
              localStorage.setItem("kladovka-theme", v);
            }}
            onSoundsChange={setSoundSettings}
            onClose={() => setShowSettings(false)}
          />
        )}

        {conflict && (
          <ConflictDialog
            t={t}
            onChoose={(policy) => {
              const c = conflict;
              setConflict(null);
              void ops.runTransfer(c.mode, c.paths, c.dest, policy);
            }}
            onCancel={() => setConflict(null)}
          />
        )}

        {dialog && (
          <CreateDialog
            t={t}
            dialog={dialog}
            onChange={setDialog}
            onCommit={() => void ops.commitCreate()}
            onCancel={() => setDialog(null)}
          />
        )}
      </main>
    </div>
  );
}
