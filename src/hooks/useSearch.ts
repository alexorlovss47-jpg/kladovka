/**
 * Поиск и фильтрация.
 *
 * Два уровня:
 *  - быстрый фильтр по уже загруженному списку (расширение, размер, дата,
 *    тип) — не требует запросов, работает мгновенно;
 *  - глубокий поиск по поддереву через Rust (`advanced_search`), с
 *    фильтрами и лимитом.
 */

import { useCallback, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DuplicateGroup, Entry, QuickFilter, SearchFilter, SearchResult } from "../types";

export const DEFAULT_QUICK: QuickFilter = {
  ext: "",
  minSize: null,
  maxSize: null,
  period: "all",
  kind: "all",
};

/** Секунды для периода. */
const PERIOD_SECS: Record<QuickFilter["period"], number> = {
  all: 0,
  day: 86400,
  week: 7 * 86400,
  month: 30 * 86400,
  year: 365 * 86400,
};

/**
 * Применить быстрый фильтр к списку записей.
 *
 * Чистая функция — её и тестируем. Каталоги проходят фильтр по расширению
 * только при пустом расширении: папка не имеет типа файла.
 */
export function applyQuickFilter(
  entries: Entry[],
  f: QuickFilter,
  nowSecs: number = Math.floor(Date.now() / 1000),
): Entry[] {
  const ext = f.ext.trim().toLowerCase().replace(/^\./, "");
  const periodSecs = PERIOD_SECS[f.period];

  return entries.filter((e) => {
    if (f.kind === "files" && e.is_dir) return false;
    if (f.kind === "dirs" && !e.is_dir) return false;

    if (ext) {
      if (e.is_dir) return false;
      if ((e.extension ?? "").toLowerCase() !== ext) return false;
    }

    if (!e.is_dir) {
      const size = e.size ?? 0;
      if (f.minSize !== null && size < f.minSize) return false;
      if (f.maxSize !== null && size > f.maxSize) return false;
    } else if (f.minSize !== null || f.maxSize !== null) {
      // Размер папки неизвестен — при фильтре по размеру её не показываем,
      // иначе выдача противоречит фильтру.
      return false;
    }

    if (periodSecs > 0) {
      const mod = e.modified ?? 0;
      if (mod < nowSecs - periodSecs) return false;
    }

    return true;
  });
}

/** Активен ли хотя бы один фильтр (для индикатора в интерфейсе). */
export function isFilterActive(f: QuickFilter): boolean {
  return f.ext.trim() !== "" || f.minSize !== null || f.maxSize !== null || f.period !== "all" || f.kind !== "all";
}

export function useAdvancedSearch() {
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateGroup[] | null>(null);
  const [largest, setLargest] = useState<Entry[] | null>(null);

  const run = useCallback(
    async (root: string, filter: SearchFilter) => {
      setSearching(true);
      setError(null);
      setDuplicates(null);
      setLargest(null);
      try {
        const r = await invoke<SearchResult>("advanced_search", { root, filter });
        setResult(r);
      } catch (e) {
        setError(String(e));
      } finally {
        setSearching(false);
      }
    },
    [],
  );

  const runDuplicates = useCallback(async (root: string) => {
    setSearching(true);
    setError(null);
    setResult(null);
    setLargest(null);
    try {
      setDuplicates(await invoke<DuplicateGroup[]>("find_duplicates", { root, limit: 200 }));
    } catch (e) {
      setError(String(e));
    } finally {
      setSearching(false);
    }
  }, []);

  const runLargest = useCallback(async (root: string) => {
    setSearching(true);
    setError(null);
    setResult(null);
    setDuplicates(null);
    try {
      setLargest(await invoke<Entry[]>("largest_files", { root, limit: 50, includeHidden: false }));
    } catch (e) {
      setError(String(e));
    } finally {
      setSearching(false);
    }
  }, []);

  const clear = useCallback(() => {
    setResult(null);
    setDuplicates(null);
    setLargest(null);
    setError(null);
  }, []);

  return {
    result,
    searching,
    error,
    duplicates,
    largest,
    run,
    runDuplicates,
    runLargest,
    clear,
  };
}

/** Мемоизированный быстрый фильтр. */
export function useQuickFiltered(entries: Entry[], filter: QuickFilter) {
  return useMemo(() => applyQuickFilter(entries, filter), [entries, filter]);
}
