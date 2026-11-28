/** Навигация по каталогам: загрузка, история, переходы. */

import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DirListing } from "../types";

export function useNavigation(showHidden: boolean) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // История в ref: load читает её, не пересоздаваясь на каждый переход.
  const historyRef = useRef<string[]>([]);
  historyRef.current = history;

  const load = useCallback(
    async (path: string, pushHistory = true) => {
      setLoading(true);
      try {
        const res = await invoke<DirListing>("list_dir", { path, showHidden });
        setListing(res);
        setError(res.error);
        if (pushHistory) {
          setHistory((prev) => {
            if (prev[prev.length - 1] === res.path) return prev;
            const next = [...prev, res.path];
            historyRef.current = next;
            return next;
          });
          setHistIdx((i) => i + 1);
        }
        return res;
      } catch (e) {
        setError(String(e));
        return null;
      } finally {
        setLoading(false);
      }
    },
    [showHidden],
  );

  const refresh = useCallback(() => {
    if (listing) void load(listing.path, false);
  }, [listing, load]);

  const go = useCallback((path: string) => void load(path, true), [load]);

  const goBack = useCallback(() => {
    setHistIdx((i) => {
      if (i <= 0) return i;
      void load(historyRef.current[i - 1], false);
      return i - 1;
    });
  }, [load]);

  const goForward = useCallback(() => {
    setHistIdx((i) => {
      if (i >= historyRef.current.length - 1) return i;
      void load(historyRef.current[i + 1], false);
      return i + 1;
    });
  }, [load]);

  const goUp = useCallback(() => {
    if (listing?.parent) go(listing.parent);
  }, [listing, go]);

  const resetHistory = useCallback((path: string) => {
    historyRef.current = [path];
    setHistory([path]);
    setHistIdx(0);
  }, []);

  return {
    listing,
    setListing,
    history,
    histIdx,
    loading,
    error,
    setError,
    load,
    refresh,
    go,
    goBack,
    goForward,
    goUp,
    resetHistory,
  };
}
