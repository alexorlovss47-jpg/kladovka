/** Форматирование и мелкие чистые функции представления. */

import type { Dict } from "./i18n";
import type { Crumb, Entry, FileTemplate } from "./types";

/** Ключи мест приходят из Rust по-русски; переводим на текущий язык. */
export const placeLabel = (label: string, t: Dict): string => {
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

/** Возвращает функцию форматирования размера, привязанную к словарю. */
export const fmtSizeWith = (t: Dict) => (n: number | null): string => {
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

const DATE_FMT = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** Unix-секунды → «дд.мм.гг чч:мм». */
export const fmtDate = (ts: number | null): string => (ts ? DATE_FMT.format(new Date(ts * 1000)) : "");

const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "svg", "tiff"];
const VIDEO_EXT = ["mp4", "mkv", "mov", "avi", "webm", "m4v"];
const AUDIO_EXT = ["mp3", "flac", "wav", "m4a", "aac", "ogg"];
const ARCHIVE_EXT = ["zip", "rar", "7z", "tar", "gz", "bz2"];
const CODE_EXT = [
  "rs", "ts", "tsx", "js", "jsx", "py", "go", "c", "cpp", "h",
  "json", "toml", "yml", "yaml", "sh", "md",
];

/** Эмодзи-иконка по типу файла. */
export const iconFor = (e: Entry): string => {
  if (e.is_dir) return "📁";
  const x = e.extension ?? "";
  if (IMAGE_EXT.includes(x)) return "🖼";
  if (VIDEO_EXT.includes(x)) return "🎬";
  if (AUDIO_EXT.includes(x)) return "🎵";
  if (x === "pdf") return "📕";
  if (ARCHIVE_EXT.includes(x)) return "📦";
  if (x === "app") return "🚀";
  if (CODE_EXT.includes(x)) return "📄";
  return "📃";
};

/** Разбить абсолютный путь на хлебные крошки. */
export const buildCrumbs = (path: string | undefined): Crumb[] => {
  if (!path) return [];
  const parts = path.split("/").filter(Boolean);
  const out: Crumb[] = [{ label: "/", path: "/" }];
  let acc = "";
  for (const p of parts) {
    acc += "/" + p;
    out.push({ label: p, path: acc });
  }
  return out;
};

/** Сравнение записей для сортировки: папки всегда первыми. */
export const compareEntries =
  (sortKey: "name" | "size" | "date", sortDir: 1 | -1) =>
  (a: Entry, b: Entry): number => {
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

/** Имя последнего сегмента пути. */
export const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Шаблоны файлов для меню «Создать». */
export const fileTemplates = (t: Dict): FileTemplate[] => [
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
