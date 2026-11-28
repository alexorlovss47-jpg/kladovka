import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { dict, resolveLang, type Lang, type Dict } from "./i18n";
import { playSound, loadSoundSettings, saveSoundSettings, type SoundSettings } from "./sounds";
import "./App.css";

type Entry = {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number | null;
  modified: number | null;
  extension: string | null;
  is_hidden: boolean;
};

type DirListing = {
  path: string;
  parent: string | null;
  entries: Entry[];
  error: string | null;
};

type DiskInfo = { mount: string; label: string; total: number; available: number; removable: boolean; ico: string };

type OpProgress = {
  op_id: number;
  kind: string;
  done: number;
  total: number;
  current: string;
  finished: boolean;
  error: string | null;
};


/** Ключи мест приходят из Rust по-русски; переводим на текущий язык. */
const placeLabel = (label: string, t: Dict) => {
  const map: Record<string, string> = {
    "Домашняя": t.home,
    "Документы": t.documents,
    "Загрузки": t.downloads,
    "Рабочий стол": t.desktop,
    "Картинки": t.pictures,
    "Проекты": t.projects,
  };
  return map[label] ?? label;
};

const fmtSizeWith = (t: Dict) => (n: number | null) => {
  if (n === null) return "";
  const units = [t.kb, t.mb, t.gb, t.tb];
  if (n < 1024) return `${n} ${t.b}`;
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
};

const fmtDate = (ts: number | null) => {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const iconFor = (e: Entry) => {
  if (e.is_dir) return "📁";
  const x = e.extension ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "svg", "tiff"].includes(x)) return "🖼";
  if (["mp4", "mkv", "mov", "avi", "webm", "m4v"].includes(x)) return "🎬";
  if (["mp3", "flac", "wav", "m4a", "aac", "ogg"].includes(x)) return "🎵";
  if (["pdf"].includes(x)) return "📕";
  if (["zip", "rar", "7z", "tar", "gz", "bz2"].includes(x)) return "📦";
  if (["app"].includes(x)) return "🚀";
  if (["rs", "ts", "tsx", "js", "jsx", "py", "go", "c", "cpp", "h", "json", "toml", "yml", "yaml", "sh", "md"].includes(x))
    return "📄";
  return "📃";
};

export default function App() {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [progress, setProgress] = useState<OpProgress | null>(null);
  const [places, setPlaces] = useState<DiskInfo[]>([]);
  const [disks, setDisks] = useState<DiskInfo[]>([]);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Entry[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [clipboard, setClipboard] = useState<{ mode: "copy" | "cut"; paths: string[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [dialog, setDialog] = useState<{ kind: "dir" | "file"; value: string } | null>(null);
  const [newMenu, setNewMenu] = useState(false);
  const [langPref, setLangPref] = useState<Lang | "auto">(
    () => (localStorage.getItem("kladovka-lang") as Lang | "auto") || "auto"
  );
  const [showSettings, setShowSettings] = useState(false);
  const [sortKey, setSortKey] = useState<"name" | "size" | "date">("name");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [themePref, setThemePref] = useState<"auto" | "light" | "dark">(
    () => (localStorage.getItem("kladovka-theme") as "auto" | "light" | "dark") || "auto"
  );
  const [dropActive, setDropActive] = useState(false);
  const [soundSettings, setSoundSettings] = useState<SoundSettings>(() => loadSoundSettings());
  const [showShortcuts, setShowShortcuts] = useState(false);
  const lang: Lang = resolveLang(langPref);
  const t: Dict = dict[lang];
  const fmtSize = fmtSizeWith(t);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (path: string, pushHistory = true) => {
      setLoading(true);
      try {
        const res = await invoke<DirListing>("list_dir", { path, showHidden });
        setListing(res);
        setError(res.error);
        setSelection(new Set());
        setAnchor(null);
        setSearchResults(null);
        if (pushHistory) {
          setHistory((prev) => {
            if (prev[prev.length - 1] === res.path) return prev;
            return [...prev, res.path];
          });
          setHistIdx((i) => i + 1);
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [showHidden]
  );

  const refresh = useCallback(() => {
    if (listing) load(listing.path, false);
  }, [listing, load]);

  useEffect(() => {
    (async () => {
      const home = await invoke<string>("home_dir");
      setPlaces(await invoke<DiskInfo[]>("special_dirs"));
      setDisks(await invoke<DiskInfo[]>("disk_info"));
      await load(home, true);
      setHistIdx(0);
    })();
    // eslint-disable-next-line
  }, []);

  // Флешки и внешние диски подключают прямо во время работы — список томов
  // надо перечитывать. Опрос раз в 3 секунды дешёвый (read_dir + statvfs),
  // а без него новый том появляется только после перезапуска приложения.
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

  useEffect(() => {
    if (listing) load(listing.path, false);
    // eslint-disable-next-line
  }, [showHidden]);

  useEffect(() => {
    const un = listen<OpProgress>("op-progress", (ev) => {
      setProgress(ev.payload);
      if (ev.payload.finished) {
        if (!ev.payload.error) {
          playSound(ev.payload.kind === "move" ? "move" : "copy", soundSettings);
        } else {
          playSound("error", soundSettings);
        }
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

  // Тема: auto -> следует за системой (media query), иначе атрибут на <html>
  useEffect(() => {
    const root = document.documentElement;
    if (themePref === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", themePref);
  }, [themePref]);

  // Приём файлов, перетащенных из Finder в окно
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((ev) => {
        const p = ev.payload;
        if (p.type === "drop") {
          setDropActive(false);
          if (p.paths.length && listing) {
            const dest = listing.path;
            // файл из самой папки в эту же папку не трогаем (иначе «file 1»)
            const sources = p.paths.filter((s) => s.slice(0, s.lastIndexOf("/")) !== dest);
            if (sources.length) {
              playSound("drop", soundSettings);
              invoke("copy_paths", { sources, destDir: dest })
                .then(() => refresh())
                .catch((e) => setError(String(e)));
            }
          }
        } else if (p.type === "enter") {
          setDropActive(true);
        } else if (p.type === "leave") {
          setDropActive(false);
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
  }, [listing, refresh]);

  const entries = useMemo(() => {
    const base = searchResults ?? listing?.entries ?? [];
    const cmp = (a: Entry, b: Entry) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      let r = 0;
      if (sortKey === "name") {
        r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      } else if (sortKey === "size") {
        r = (a.size ?? -1) - (b.size ?? -1);
      } else {
        r = (a.modified ?? 0) - (b.modified ?? 0);
      }
      return r * sortDir;
    };
    return [...base].sort(cmp);
  }, [searchResults, listing, sortKey, sortDir]);

  const toggleSort = (k: "name" | "size" | "date") => {
    if (sortKey === k) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(k);
      setSortDir(k === "name" ? 1 : -1);
    }
  };

  const go = (path: string) => load(path, true);

  const goBack = () => {
    if (histIdx > 0) {
      const i = histIdx - 1;
      setHistIdx(i);
      load(history[i], false);
    }
  };
  const goForward = () => {
    if (histIdx < history.length - 1) {
      const i = histIdx + 1;
      setHistIdx(i);
      load(history[i], false);
    }
  };
  const goUp = () => {
    if (listing?.parent) go(listing.parent);
  };

  const clickEntry = (e: Entry, ev: React.MouseEvent) => {
    const next = new Set(ev.metaKey || ev.ctrlKey ? selection : []);
    if (ev.shiftKey && anchor) {
      const paths = entries.map((x) => x.path);
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
    } else invoke("open_path", { path: e.path }).catch((err) => setError(String(err)));
  };

  const doCopy = async () => {
    if (!clipboard || !listing) return;
    try {
      if (clipboard.mode === "cut") {
        await invoke("move_paths", { sources: clipboard.paths, destDir: listing.path });
        setClipboard(null);
      } else {
        await invoke("copy_paths", { sources: clipboard.paths, destDir: listing.path });
      }
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const doTrash = async () => {
    if (!selection.size) return;
    // Звук не играем: Finder при перемещении в Корзину проигрывает свой системный звук
    try {
      await invoke("trash_paths", { paths: [...selection] });
      refresh();
    } catch (e) {
      playSound("error", soundSettings);
      setError(String(e));
    }
  };

  const doRename = async (path: string, name: string) => {
    try {
      await invoke("rename_path", { from: path, toName: name });
      playSound("rename", soundSettings);
      setRenaming(null);
      refresh();
    } catch (e) {
      playSound("error", soundSettings);
      setError(String(e));
    }
  };

  const doNewFolder = () => {
    if (!listing) return;
    setNewMenu(false);
    setDialog({ kind: "dir", value: t.defaultFolderName });
  };

  const fileTemplates: { label: string; ext: string; icon: string }[] = [
    { label: t.txtFile, ext: "txt", icon: "📄" },
    { label: t.markdown, ext: "md", icon: "📝" },
    { label: t.json, ext: "json", icon: "🧩" },
    { label: t.csv, ext: "csv", icon: "📊" },
    { label: t.docx, ext: "docx", icon: "📘" },
    { label: t.xlsx, ext: "xlsx", icon: "📗" },
    { label: t.python, ext: "py", icon: "🐍" },
    { label: t.rust, ext: "rs", icon: "🦀" },
    { label: t.shell, ext: "sh", icon: "⌨" },
    { label: t.html, ext: "html", icon: "🌐" },
  ];

  const doNewFile = (ext?: string) => {
    if (!listing) return;
    setNewMenu(false);
    setDialog({ kind: "file", value: ext ? `${t.defaultFileName}.${ext}` : `${t.defaultFileName}.txt` });
  };

  const commitDialog = async () => {
    if (!dialog || !listing || !dialog.value.trim()) {
      setDialog(null);
      return;
    }
    const name = dialog.value.trim();
    try {
      if (dialog.kind === "dir") {
        await invoke("create_dir", { parent: listing.path, name });
      } else {
        await invoke("create_file", { parent: listing.path, name });
      }
      playSound("new", soundSettings);
      setDialog(null);
      refresh();
    } catch (e) {
      playSound("error", soundSettings);
      setError(String(e));
      setDialog(null);
    }
  };

  const doSearch = async () => {
    if (!query.trim() || !listing) {
      setSearchResults(null);
      return;
    }
    setLoading(true);
    try {
      const res = await invoke<Entry[]>("search_tree", { root: listing.path, query, limit: 300 });
      setSearchResults(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
        ev.preventDefault();
        if (!entries.length) return;
        const paths = entries.map((e) => e.path);
        let idx = anchor ? paths.indexOf(anchor) : -1;
        idx = ev.key === "ArrowDown" ? Math.min(idx + 1, paths.length - 1) : Math.max(idx - 1, 0);
        setSelection(new Set([paths[idx]]));
        setAnchor(paths[idx]);
        return;
      }
      if (ev.key === "Enter" && anchor) {
        const e = entries.find((x) => x.path === anchor);
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
        doCopy();
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "a") {
        ev.preventDefault();
        setSelection(new Set(entries.map((e) => e.path)));
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Backspace") {
        doTrash();
        return;
      }
      if (ev.key === "F2" && anchor) {
        const e = entries.find((x) => x.path === anchor);
        if (e) {
          setRenaming(e.path);
          setRenameValue(e.name);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line
  }, [entries, anchor, selection, clipboard, listing]);

  const onEmptyClick = (ev: React.MouseEvent) => {
    if (ev.target === ev.currentTarget) {
      setSelection(new Set());
      setAnchor(null);
    }
  };

  const totalSize = useMemo(() => {
    const sel = entries.filter((e) => selection.has(e.path) && e.size !== null);
    return sel.reduce((s, e) => s + (e.size ?? 0), 0);
  }, [entries, selection]);

  const crumbs = useMemo(() => {
    if (!listing) return [];
    const parts = listing.path.split("/").filter(Boolean);
    const out: { label: string; path: string }[] = [{ label: "/", path: "/" }];
    let acc = "";
    for (const p of parts) {
      acc += "/" + p;
      out.push({ label: p, path: acc });
    }
    return out;
  }, [listing]);

  const pct = progress && progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0;

  return (
    <div className="fm">
      <aside className="sidebar">
        <div className="side-title">{t.places}</div>
        {places.map((p) => (
          <button
            key={p.mount}
            className={"side-item" + (listing?.path === p.mount ? " active" : "")}
            onClick={() => go(p.mount)}
          >
            <span className="side-ico">{p.ico}</span>
            {placeLabel(p.label, t)}
          </button>
        ))}
        <div className="side-title" style={{ marginTop: 18 }}>
          {t.disks}
        </div>
        {disks.map((d) => (
          <div key={d.mount} className="disk-group">
            <button
              className={"side-item" + (listing?.path === d.mount ? " active" : "")}
              onClick={() => go(d.mount)}
            >
              <span className="side-ico">{d.removable ? "💾" : "🖥"}</span>
              <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {d.label}
              </span>
            </button>
            {d.total > 0 && (
              <div className="disk-bar">
                <div className="disk-track">
                  <div
                    className="disk-fill"
                    style={{ width: `${Math.min(100, ((d.total - d.available) / d.total) * 100)}%` }}
                  />
                </div>
                <div className="disk-label">
                  {fmtSize(d.available)} {t.freeOf} {fmtSize(d.total)}
                </div>
              </div>
            )}
          </div>
        ))}
      </aside>

      <main className="main">
        <div className="toolbar">
          <button className="tb" onClick={goBack} disabled={histIdx <= 0} title={t.back}>
            ←
          </button>
          <button className="tb" onClick={goForward} disabled={histIdx >= history.length - 1} title={t.forward}>
            →
          </button>
          <button className="tb" onClick={goUp} disabled={!listing?.parent} title={t.up}>
            ↑
          </button>

          <div className="crumbs">
            {crumbs.map((c, i) => (
              <span key={c.path}>
                <button className="crumb" onClick={() => go(c.path)}>
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
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") doSearch();
              if (e.key === "Escape") {
                setQuery("");
                setSearchResults(null);
              }
            }}
          />

          <div className="new-menu-wrap">
            <button className="tb new-btn" onClick={() => setNewMenu((v) => !v)} title={t.create}>
              + <span className="new-caret">▾</span>
            </button>
            {newMenu && (
              <>
                <div className="menu-backdrop" onClick={() => setNewMenu(false)} />
                <div className="menu">
                  <button className="menu-item" onClick={doNewFolder}>
                    <span className="menu-ico">📁</span> {t.newFolder}
                  </button>
                  <div className="menu-sep" />
                  <div className="menu-label">{t.newFile}</div>
                  {fileTemplates.map((t) => (
                    <button key={t.ext} className="menu-item" onClick={() => doNewFile(t.ext)}>
                      <span className="menu-ico">{t.icon}</span> {t.label}
                      <span className="menu-ext">.{t.ext}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button className="tb" onClick={() => setShowHidden((v) => !v)} title={t.showHidden}>
            {showHidden ? "👁" : "🚫"}
          </button>
          <button className="tb" onClick={refresh} title={t.refresh}>
            ⟳
          </button>
          <button className="tb" onClick={() => setShowSettings(true)} title={t.settings}>
            ⚙
          </button>
          <button className="tb" onClick={() => setShowShortcuts(true)} title={t.shortcuts}>
            ?
          </button>
        </div>

        {listing && (
          <div className="path-bar">
            <span className="path-text">{listing.path}</span>
            {selection.size > 0 && (
              <span className="sel-info">
                {t.selected} {selection.size}
                {totalSize > 0 ? ` · ${fmtSize(totalSize)}` : ""}
              </span>
            )}
            {searchResults !== null && <span className="sel-info">{t.found} {searchResults.length}</span>}
          </div>
        )}

        {error && (
          <div className="error" onClick={() => setError(null)}>
            {error} <span className="err-x">✕</span>
          </div>
        )}

        <div className="list-head">
          <span style={{ width: 28 }} />
          <span
            className={"th" + (sortKey === "name" ? " sorted" : "")}
            style={{ flex: 1 }}
            onClick={() => toggleSort("name")}
          >
            {t.colName}
            {sortKey === "name" && <span className="th-arrow">{sortDir === 1 ? "▲" : "▼"}</span>}
          </span>
          <span
            className={"th" + (sortKey === "size" ? " sorted" : "")}
            style={{ width: 110, textAlign: "right" }}
            onClick={() => toggleSort("size")}
          >
            {t.colSize}
            {sortKey === "size" && <span className="th-arrow">{sortDir === 1 ? "▲" : "▼"}</span>}
          </span>
          <span
            className={"th" + (sortKey === "date" ? " sorted" : "")}
            style={{ width: 150, textAlign: "right" }}
            onClick={() => toggleSort("date")}
          >
            {t.colModified}
            {sortKey === "date" && <span className="th-arrow">{sortDir === 1 ? "▲" : "▼"}</span>}
          </span>
        </div>

        <div className="list" ref={listRef} onClick={onEmptyClick}>
          {loading && <div className="loading">{t.loading}</div>}
          {!loading && entries.length === 0 && !error && <div className="empty">{t.empty}</div>}
          {entries.map((e) => (
            <div
              key={e.path}
              className={
                "row" + (selection.has(e.path) ? " selected" : "") + (e.is_dir ? " dir" : "") + (e.is_hidden ? " hidden" : "")
              }
              onClick={(ev) => {
                if (renaming === e.path) return;
                clickEntry(e, ev);
              }}
              onDoubleClick={() => openEntry(e)}
              onContextMenu={(ev) => {
                ev.preventDefault();
                if (!selection.has(e.path)) {
                  setSelection(new Set([e.path]));
                  setAnchor(e.path);
                }
              }}
            >
              <span className="ico">{iconFor(e)}</span>
              {renaming === e.path ? (
                <input
                  className="rename-input"
                  autoFocus
                  value={renameValue}
                  onChange={(ev) => setRenameValue(ev.target.value)}
                  onBlur={() => setRenaming(null)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") doRename(e.path, renameValue);
                    if (ev.key === "Escape") setRenaming(null);
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

        <div className="actions">
          {selection.size > 0 ? (
            <>
              <button className="act" onClick={() => setClipboard({ mode: "copy", paths: [...selection] })}>
                {t.copy}
              </button>
              <button className="act" onClick={() => setClipboard({ mode: "cut", paths: [...selection] })}>
                {t.cut}
              </button>
              <button className="act danger" onClick={doTrash}>
                {t.trash}
              </button>
              {selection.size === 1 && (
                <>
                  <button
                    className="act"
                    onClick={() => {
                      const p = [...selection][0];
                      const e = entries.find((x) => x.path === p);
                      if (e) {
                        setRenaming(e.path);
                        setRenameValue(e.name);
                      }
                    }}
                  >
                    {t.rename}
                  </button>
                  <button className="act" onClick={() => invoke("reveal_path", { path: [...selection][0] })}>
                    {t.revealInFinder}
                  </button>
                </>
              )}
            </>
          ) : (
            <span className="hint">
              {clipboard
                ? `${t.clipboardHas}: ${clipboard.paths.length} (${clipboard.mode === "copy" ? t.copyWord : t.cutWord})`
                : t.hint}
            </span>
          )}
          {clipboard && (
            <button className="act" onClick={doCopy}>
              {t.pasteHere}
            </button>
          )}
        </div>

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
          <span className="bh-item"><kbd>↑↓</kbd> {t.scUp}</span>
          <span className="bh-item"><kbd>{t.scAddKey}</kbd> {t.scAdd}</span>
          <span className="bh-item"><kbd>{t.scRangeKey}</kbd> {t.scRange}</span>
          <span className="bh-item"><kbd>⌘A</kbd> {t.scAll}</span>
          <span className="bh-item"><kbd>⌘⌫</kbd> {t.scTrash}</span>
          <span className="bh-item"><kbd>?</kbd> {t.scHelp}</span>
        </div>

        {showShortcuts && (
          <div className="modal-backdrop" onClick={() => setShowShortcuts(false)}>
            <div className="modal shortcuts-modal" onClick={(ev) => ev.stopPropagation()}>
              <div className="modal-title">{t.shortcuts}</div>
              <div className="sc-grid">
                <div>
                  <div className="sc-title">{t.shortcutsNav}</div>
                  <div className="sc-row"><span>↑ ↓</span><span>{t.scUp}</span></div>
                  <div className="sc-row"><span>↵</span><span>{t.scOpen}</span></div>
                  <div className="sc-row"><span>⌫</span><span>{t.scUpDir}</span></div>
                  <div className="sc-row"><span>← →</span><span>{t.scHistory}</span></div>
                </div>
                <div>
                  <div className="sc-title">{t.shortcutsSelect}</div>
                  <div className="sc-row"><span>{t.scAddKey}</span><span>{t.scAdd}</span></div>
                  <div className="sc-row"><span>{t.scRangeKey}</span><span>{t.scRange}</span></div>
                  <div className="sc-row"><span>⌘A</span><span>{t.scAll}</span></div>
                  <div className="sc-row"><span>Esc</span><span>{t.scClear}</span></div>
                </div>
                <div>
                  <div className="sc-title">{t.shortcutsActions}</div>
                  <div className="sc-row"><span>⌘C</span><span>{t.scCopy}</span></div>
                  <div className="sc-row"><span>⌘X</span><span>{t.scCut}</span></div>
                  <div className="sc-row"><span>⌘V</span><span>{t.scPaste}</span></div>
                  <div className="sc-row"><span>⌘⌫</span><span>{t.scTrash}</span></div>
                  <div className="sc-row"><span>F2</span><span>{t.scRename}</span></div>
                </div>
                <div>
                  <div className="sc-title">{t.shortcutsMisc}</div>
                  <div className="sc-row"><span>⌘F</span><span>{t.scSearch}</span></div>
                  <div className="sc-row"><span>?</span><span>{t.scHelp}</span></div>
                </div>
              </div>
              <div className="modal-actions">
                <button className="act primary" onClick={() => setShowShortcuts(false)}>
                  {t.close}
                </button>
              </div>
            </div>
          </div>
        )}

        {showSettings && (
          <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
            <div className="modal" onClick={(ev) => ev.stopPropagation()}>
              <div className="modal-title">{t.settings}</div>
              <div className="set-row">
                <span className="set-label">{t.language}</span>
                <div className="lang-opts">
                  {(["auto", "ru", "en"] as const).map((v) => (
                    <button
                      key={v}
                      className={"lang-btn" + (langPref === v ? " active" : "")}
                      onClick={() => {
                        setLangPref(v);
                        localStorage.setItem("kladovka-lang", v);
                      }}
                    >
                      {v === "auto" ? t.languageAuto : v === "ru" ? t.languageRu : t.languageEn}
                    </button>
                  ))}
                </div>
              </div>
              <div className="set-row">
                <span className="set-label">{t.theme}</span>
                <div className="lang-opts">
                  {(["auto", "light", "dark"] as const).map((v) => (
                    <button
                      key={v}
                      className={"lang-btn" + (themePref === v ? " active" : "")}
                      onClick={() => {
                        setThemePref(v);
                        localStorage.setItem("kladovka-theme", v);
                      }}
                    >
                      {v === "auto" ? t.themeAuto : v === "light" ? t.themeLight : t.themeDark}
                    </button>
                  ))}
                </div>
              </div>
              <div className="set-row">
                <span className="set-label">{t.sounds}</span>
                <div className="lang-opts">
                  <button
                    className={"lang-btn" + (soundSettings.enabled ? " active" : "")}
                    onClick={() => {
                      const next = { ...soundSettings, enabled: !soundSettings.enabled };
                      setSoundSettings(next);
                      saveSoundSettings(next);
                    }}
                  >
                    {soundSettings.enabled ? t.soundsOn : t.soundsOff}
                  </button>
                </div>
              </div>
              {soundSettings.enabled && (
                <>
                  <div className="set-row">
                    <span className="set-label">
                      {t.soundVolume} · {Math.round(soundSettings.volume * 100)}%
                    </span>
                    <input
                      className="volume-slider"
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round(soundSettings.volume * 100)}
                      onChange={(e) => {
                        const next = { ...soundSettings, volume: Number(e.target.value) / 100 };
                        setSoundSettings(next);
                        saveSoundSettings(next);
                      }}
                    />
                  </div>
                  {(
                    [
                      ["select", t.soundSelect],
                      ["copy", t.soundCopy],
                      ["move", t.soundMove],
                      ["drop", t.soundDrop],
                      ["error", t.soundError],
                      ["rename", t.soundRename],
                      ["new", t.soundNew],
                    ] as const
                  ).map(([name, label]) => (
                    <div className="set-row sound-row" key={name}>
                      <span className="sound-name">{label}</span>
                      <div className="lang-opts">
                        <button
                          className={"lang-btn" + (soundSettings.muted[name] ? "" : " active")}
                          onClick={() => {
                            const next = {
                              ...soundSettings,
                              muted: { ...soundSettings.muted, [name]: !soundSettings.muted[name] },
                            };
                            setSoundSettings(next);
                            saveSoundSettings(next);
                          }}
                        >
                          {soundSettings.muted[name]
                            ? t.soundOffShort
                            : t.soundOnShort}
                        </button>
                        <button className="lang-btn" onClick={() => playSound(name, soundSettings)}>
                          {t.test}
                        </button>
                      </div>
                    </div>
                  ))}
                </>
              )}
              <div className="modal-actions">
                <button className="act primary" onClick={() => setShowSettings(false)}>
                  {t.close}
                </button>
              </div>
            </div>
          </div>
        )}

        {dialog && (
          <div className="modal-backdrop" onClick={() => setDialog(null)}>
            <div className="modal" onClick={(ev) => ev.stopPropagation()}>
              <div className="modal-title">{dialog.kind === "dir" ? t.newFolderTitle : t.newFileTitle}</div>
              <input
                className="modal-input"
                autoFocus
                value={dialog.value}
                onChange={(ev) => setDialog({ ...dialog, value: ev.target.value })}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") commitDialog();
                  if (ev.key === "Escape") setDialog(null);
                }}
              />
              <div className="modal-actions">
                <button className="act" onClick={() => setDialog(null)}>
                  {t.cancel}
                </button>
                <button className="act primary" onClick={commitDialog}>
                  {t.create2}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
