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
  | "toggleHidden"
  | "togglePreview"
  | "advancedSearch"
  | "extras";

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

/** Метаданные для панели предпросмотра (зеркалит PreviewInfo из Rust). */
export type PreviewInfo = {
  path: string;
  name: string;
  is_dir: boolean;
  size: number | null;
  modified: number | null;
  created: number | null;
  /** image / pdf / text / binary / directory / symlink / other */
  kind: string;
  extension: string | null;
  image_dimensions: [number, number] | null;
  pdf_pages: number | null;
  too_large: boolean;
  link_target: string | null;
};

/** Прочитанный текст для предпросмотра. */
export type TextPreview = {
  content: string;
  truncated: boolean;
  bytes_read: number;
  size: number;
};

/** Фильтр поиска (зеркалит SearchFilter из search.rs). */
export type SearchFilter = {
  query: string;
  extension: string | null;
  min_size: number | null;
  max_size: number | null;
  modified_after: number | null;
  modified_before: number | null;
  include_hidden: boolean;
  include_dirs: boolean;
  include_files: boolean;
  max_depth: number;
  limit: number;
};

export type SearchResult = {
  entries: Entry[];
  truncated: boolean;
  scanned: number;
};

/** Группа дубликатов. */
export type DuplicateGroup = { size: number; entries: Entry[] };

/** Быстрые фильтры поверх текущего каталога (без обхода дерева). */
export type QuickFilter = {
  ext: string;
  minSize: number | null;
  maxSize: number | null;
  period: "all" | "day" | "week" | "month" | "year";
  kind: "all" | "files" | "dirs";
};

/** План пакетного переименования (зеркалит RenamePlan). */
export type RenamePlan = { from: string; to: string; conflict: boolean };

/** Разница двух каталогов. */
export type DiffKind = "OnlyLeft" | "OnlyRight" | "Different" | "Same";
export type DiffEntry = {
  relative: string;
  kind: DiffKind;
  left_size: number | null;
  right_size: number | null;
};
export type DirDiff = {
  entries: DiffEntry[];
  only_left: number;
  only_right: number;
  different: number;
  same: number;
};

/** Размер каталога. */
export type FolderSize = { bytes: number; files: number; dirs: number };

/** Результат архивации. */
export type ArchiveResult = { path: string; files: number; bytes: number };
