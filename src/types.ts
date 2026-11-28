/** Общие типы домена. Зеркалят структуры из src-tauri/src/lib.rs. */

export type Entry = {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number | null;
  modified: number | null;
  extension: string | null;
  is_hidden: boolean;
};

export type DirListing = {
  path: string;
  parent: string | null;
  entries: Entry[];
  error: string | null;
};

export type DiskInfo = {
  mount: string;
  label: string;
  total: number;
  available: number;
  removable: boolean;
  ico: string;
};

export type OpProgress = {
  op_id: number;
  kind: string;
  done: number;
  total: number;
  current: string;
  finished: boolean;
  error: string | null;
};

export type SortKey = "name" | "size" | "date";
export type SortDir = 1 | -1;

export type ClipboardState = { mode: "copy" | "cut"; paths: string[] };

/** Политика при совпадении имени в приёмнике. */
export type ConflictPolicy = "rename" | "skip" | "overwrite";

export type ConflictPrompt = { mode: "copy" | "cut"; paths: string[]; dest: string };

export type ThemePref = "auto" | "light" | "dark";

export type NewItemDialog = { kind: "dir" | "file"; value: string };

export type Crumb = { label: string; path: string };

export type FileTemplate = { label: string; ext: string; icon: string };

/** Режим отображения списка файлов. */
export type ViewMode = "list" | "grid" | "compact";

/** Состояние одной вкладки панели. */
export type TabState = {
  id: string;
  history: string[];
  histIdx: number;
  listing: DirListing | null;
  loading: boolean;
  error: string | null;
  query: string;
  searchResults: Entry[] | null;
  sortKey: SortKey;
  sortDir: SortDir;
  /** Выделенные пути активной вкладки — своё у каждой вкладки. */
  selection: Set<string>;
  /** Якорь для shift-выделения. */
  anchor: string | null;
};

/** Состояние панели: вкладки + активная вкладка. */
export type PanelState = {
  id: string;
  tabs: TabState[];
  activeTabId: string;
};

export type Favorite = { path: string; name: string };

/** Действие, на которое можно назначить горячую клавишу. */
export type ActionName =
  | "newTab"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "focusOtherPane"
  | "toggleDualPane"
  | "newWindow"
  | "newFolder"
  | "goUp"
  | "goBack"
  | "goForward"
  | "openEntry"
  | "rename"
  | "trash"
  | "selectAll"
  | "copy"
  | "cut"
  | "paste"
  | "focusSearch"
  | "help"
  | "refresh"
  | "toggleHidden";

/** Статус операции в очереди (зеркалит OpStatus из Rust). */
export type OpStatus = "queued" | "running" | "paused" | "finished" | "failed" | "cancelled";

export type OpInfo = {
  id: number;
  kind: string;
  sources: string[];
  dest_dir: string;
  status: OpStatus;
  done: number;
  total: number;
  current: string;
  error: string | null;
  bytes_per_sec: number;
  eta_secs: number | null;
  files_done: number;
  files_total: number;
  created_at: number;
  finished_at: number | null;
};
