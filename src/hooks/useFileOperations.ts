/** Файловые операции: копирование, перемещение, удаление, создание, переименование. */

import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { playSound, type SoundSettings } from "../sounds";
import { baseName } from "../format";
import type { ConflictPolicy, ConflictPrompt, Entry, NewItemDialog } from "../types";

type Deps = {
  sounds: SoundSettings;
  /** Текущий путь каталога. */
  currentPath: string | undefined;
  /** Записи, видимые в списке — для проверки занятости имён. */
  entries: Entry[];
  refresh: () => void;
  setError: (msg: string | null) => void;
  /** Сбросить буфер обмена после перемещения. */
  clearClipboard: () => void;
};

export function useFileOperations(deps: Deps) {
  const { sounds, currentPath, entries, refresh, setError, clearClipboard } = deps;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [dialog, setDialog] = useState<NewItemDialog | null>(null);
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null);

  const fail = useCallback(
    (e: unknown) => {
      playSound("error", sounds);
      setError(String(e));
    },
    [sounds, setError],
  );

  /** Запустить копирование/перемещение с выбранной политикой конфликтов. */
  const runTransfer = useCallback(
    async (mode: "copy" | "cut", paths: string[], dest: string, policy: ConflictPolicy) => {
      try {
        await invoke(mode === "cut" ? "move_paths" : "copy_paths", {
          sources: paths,
          destDir: dest,
          conflict: policy,
        });
        if (mode === "cut") clearClipboard();
        refresh();
      } catch (e) {
        fail(e);
      }
    },
    [refresh, clearClipboard, fail],
  );

  /** Вставить из буфера. Спрашивает политику, если имя занято. */
  const paste = useCallback(
    async (clip: { mode: "copy" | "cut"; paths: string[] } | null) => {
      if (!clip || !currentPath) return;
      const taken = clip.paths.some((p) =>
        entries.some((e) => e.name === baseName(p)),
      );
      if (taken) {
        setConflict({ mode: clip.mode, paths: clip.paths, dest: currentPath });
        return;
      }
      await runTransfer(clip.mode, clip.paths, currentPath, "rename");
    },
    [currentPath, entries, runTransfer],
  );

  const trash = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return;
      // Звук не играем: Finder при перемещении в Корзину проигрывает свой.
      try {
        await invoke("trash_paths", { paths });
        refresh();
      } catch (e) {
        fail(e);
      }
    },
    [refresh, fail],
  );

  const rename = useCallback(
    async (path: string, name: string) => {
      try {
        await invoke("rename_path", { from: path, toName: name });
        playSound("rename", sounds);
        setRenaming(null);
        refresh();
      } catch (e) {
        fail(e);
      }
    },
    [refresh, sounds, fail],
  );

  const startRename = useCallback((entry: Entry) => {
    setRenaming(entry.path);
    setRenameValue(entry.name);
  }, []);

  const commitCreate = useCallback(async () => {
    if (!dialog || !currentPath || !dialog.value.trim()) {
      setDialog(null);
      return;
    }
    const name = dialog.value.trim();
    try {
      await invoke(dialog.kind === "dir" ? "create_dir" : "create_file", {
        parent: currentPath,
        name,
      });
      playSound("new", sounds);
      setDialog(null);
      refresh();
    } catch (e) {
      fail(e);
      setDialog(null);
    }
  }, [dialog, currentPath, refresh, sounds, fail]);

  return {
    renaming,
    setRenaming,
    renameValue,
    setRenameValue,
    dialog,
    setDialog,
    conflict,
    setConflict,
    runTransfer,
    paste,
    trash,
    rename,
    startRename,
    commitCreate,
  };
}
