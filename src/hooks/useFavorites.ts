/** Избранные каталоги и пользовательские настройки (localStorage). */

import { useCallback, useEffect, useState } from "react";
import type { Favorite, ViewMode } from "../types";

const FAV_KEY = "kladovka-favorites";
const PREFS_KEY = "kladovka-prefs";

export type Prefs = {
  viewMode: ViewMode;
  dualPane: boolean;
  showHidden: boolean;
};

const DEFAULT_PREFS: Prefs = { viewMode: "list", dualPane: false, showHidden: false };

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
}

export function useFavorites() {
  const [favorites, setFavorites] = useState<Favorite[]>(() => {
    const raw = localStorage.getItem(FAV_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Favorite[]) : [];
    } catch {
      return [];
    }
  });

  const persist = useCallback((next: Favorite[]) => {
    setFavorites(next);
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify(next));
    } catch {
      /* приватный режим */
    }
  }, []);

  const addFavorite = useCallback(
    (path: string) => {
      setFavorites((prev) => {
        if (prev.some((f) => f.path === path)) return prev;
        const name = path.slice(path.lastIndexOf("/") + 1) || path;
        const next = [...prev, { path, name }];
        try {
          localStorage.setItem(FAV_KEY, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [],
  );

  const removeFavorite = useCallback(
    (path: string) => {
      setFavorites((prev) => {
        const next = prev.filter((f) => f.path !== path);
        try {
          localStorage.setItem(FAV_KEY, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [],
  );

  const isFavorite = useCallback((path: string) => favorites.some((f) => f.path === path), [favorites]);

  return { favorites, addFavorite, removeFavorite, isFavorite, persist };
}

export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(() => readJson(PREFS_KEY, DEFAULT_PREFS));

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* ignore */
    }
  }, [prefs]);

  const update = useCallback((patch: Partial<Prefs>) => {
    setPrefs((prev) => ({ ...prev, ...patch }));
  }, []);

  return { prefs, update };
}
