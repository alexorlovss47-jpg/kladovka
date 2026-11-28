/**
 * Панель быстрого просмотра.
 *
 * Загружает метаданные и, при необходимости, содержимое выбранного файла.
 * Три правила, чтобы не подвесить приложение на большом файле:
 *  - метаданные приходят из Rust всегда (дешёвый stat);
 *  - текст запрашивается только пока пользователь не подтвердил большой файл;
 *  - картинки рендерим через asset-протокол, не через base64 в JS.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { PreviewInfo, TextPreview } from "../types";

type State = {
  info: PreviewInfo | null;
  text: TextPreview | null;
  loading: boolean;
  error: string | null;
};

export function usePreview(path: string | null, enabled: boolean) {
  const [state, setState] = useState<State>({
    info: null,
    text: null,
    loading: false,
    error: null,
  });

  // Гонка запросов: быстрый клик по файлам даёт ответы не по порядку.
  const seq = useRef(0);

  const loadInfo = useCallback(async (p: string) => {
    const my = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const info = await invoke<PreviewInfo>("preview_info", { path: p });
      if (my !== seq.current) return; // устаревший ответ
      setState({ info, text: null, loading: false, error: null });
    } catch (e) {
      if (my !== seq.current) return;
      setState({ info: null, text: null, loading: false, error: String(e) });
    }
  }, []);

  const loadText = useCallback(
    async (p: string) => {
      const my = ++seq.current;
      try {
        const text = await invoke<TextPreview>("read_text_preview", { path: p, limit: null });
        if (my !== seq.current) return;
        setState((s) => ({ ...s, text, loading: false }));
      } catch (e) {
        if (my !== seq.current) return;
        setState((s) => ({ ...s, error: String(e), loading: false }));
      }
    },
    [],
  );

  useEffect(() => {
    if (!enabled || !path) {
      setState({ info: null, text: null, loading: false, error: null });
      return;
    }
    void loadInfo(path);
  }, [path, enabled, loadInfo]);

  // Текст грузим отдельно и только если файл не слишком большой:
  // иначе выбор папки с 4 ГБ логом подвесит чтение.
  useEffect(() => {
    if (!path || !state.info) return;
    const { kind, too_large } = state.info;
    if (kind !== "text" || too_large) return;
    if (state.text) return;
    void loadText(path);
  }, [path, state.info, state.text, loadText]);

  return {
    ...state,
    reload: () => path && void loadInfo(path),
    loadTextForced: () => path && void loadText(path),
    /** URL картинки для <img> через asset-протокол. */
    imageUrl: path && state.info?.kind === "image" && !state.info.too_large
      ? convertFileSrc(path)
      : null,
  };
}
