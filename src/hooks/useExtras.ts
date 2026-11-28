/** Операции Этапа 6: архивы, пакетное переименование, сравнение, размеры. */

import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ArchiveResult,
  DiffEntry,
  DirDiff,
  FolderSize,
  RenamePlan,
} from "../types";

export function useExtras() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const wrap = useCallback(async <T,>(job: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      return await job();
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const archive = useCallback(
    async (sources: string[], destination: string) =>
      wrap(() => invoke<ArchiveResult>("create_archive", { sources, destination })).then((r) => {
        if (r) setMessage(`${r.files} файлов · ${Math.round(r.bytes / 1024)} КБ`);
        return r;
      }),
    [wrap],
  );

  const extract = useCallback(
    async (archivePath: string, destination: string) =>
      wrap(() => invoke<number>("extract_archive", { archive: archivePath, destination })).then(
        (n) => {
          if (n !== null) setMessage(`Распаковано файлов: ${n}`);
          return n;
        },
      ),
    [wrap],
  );

  const planRename = useCallback(
    async (paths: string[], pattern: string, start = 1, nameFilter?: string, extFilter?: string) =>
      wrap(() =>
        invoke<RenamePlan[]>("plan_rename", {
          paths,
          pattern,
          start,
          nameFilter: nameFilter ?? null,
          extFilter: extFilter ?? null,
        }),
      ),
    [wrap],
  );

  const applyRename = useCallback(
    async (plan: RenamePlan[]) =>
      wrap(() => invoke<number>("apply_rename", { plan })).then((n) => {
        if (n !== null) setMessage(`Переименовано: ${n}`);
        return n;
      }),
    [wrap],
  );

  const compare = useCallback(
    async (left: string, right: string) =>
      wrap(() => invoke<DirDiff>("compare_dirs", { left, right })),
    [wrap],
  );

  const folderSize = useCallback(
    async (path: string) => wrap(() => invoke<FolderSize>("folder_size", { path })),
    [wrap],
  );

  const copyPath = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setMessage("Путь скопирован");
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }, []);

  const clear = useCallback(() => {
    setError(null);
    setMessage(null);
  }, []);

  return {
    busy,
    error,
    message,
    archive,
    extract,
    planRename,
    applyRename,
    compare,
    folderSize,
    copyPath,
    clear,
  };
}

/** Счётчики различий для компактного отображения. */
/** Счётчики различий для компактного отображения. */
export function diffCounts(entries: DiffEntry[]) {
  return entries.reduce(
    (acc, e) => {
      if (e.kind === "OnlyLeft") acc.left++;
      else if (e.kind === "OnlyRight") acc.right++;
      else if (e.kind === "Different") acc.changed++;
      return acc;
    },
    { left: 0, right: 0, changed: 0 },
  );
}
