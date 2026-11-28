/**
 * Горячие клавиши.
 *
 * Стандартные сочетания macOS заданы по умолчанию, пользователь может
 * переназначить любое действие. Формат хранения — строка вида "cmd+shift+t"
 * (модификаторы: cmd, shift, alt, ctrl; клавиша — KEY-значения из KeyboardEvent).
 */

import { useCallback, useEffect, useState } from "react";
import type { ActionName } from "../types";

const KEY = "kladovka-keys";

export type KeyMap = Record<ActionName, string>;

export const DEFAULT_KEYS: KeyMap = {
  newTab: "cmd+t",
  closeTab: "cmd+w",
  nextTab: "cmd+alt+ArrowRight",
  prevTab: "cmd+alt+ArrowLeft",
  focusOtherPane: "F6",
  toggleDualPane: "cmd+shift+d",
  newWindow: "cmd+n",
  newFolder: "cmd+shift+n",
  goUp: "Backspace",
  goBack: "cmd+ArrowLeft",
  goForward: "cmd+ArrowRight",
  openEntry: "Enter",
  rename: "F2",
  trash: "cmd+Backspace",
  selectAll: "cmd+a",
  copy: "cmd+c",
  cut: "cmd+x",
  paste: "cmd+v",
  focusSearch: "cmd+f",
  help: "?",
  refresh: "cmd+r",
  toggleHidden: "cmd+shift+h",
  togglePreview: "cmd+i",
  advancedSearch: "cmd+shift+f",
  extras: "cmd+e",
};

/** Собрать строковое представление нажатия. */
export function eventToCombo(ev: KeyboardEvent): string {
  const parts: string[] = [];
  if (ev.metaKey) parts.push("cmd");
  if (ev.ctrlKey) parts.push("ctrl");
  if (ev.altKey) parts.push("alt");
  if (ev.shiftKey) parts.push("shift");
  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  // Одиночные модификаторы не считаем комбинацией.
  if (["meta", "control", "alt", "shift"].includes(key.toLowerCase())) return "";
  parts.push(key);
  return parts.join("+");
}

/** Человекочитаемый вид: cmd+shift+t -> ⌘⇧T */
export function prettyCombo(combo: string): string {
  return combo
    .split("+")
    .map((p) => {
      switch (p) {
        case "cmd":
          return "⌘";
        case "ctrl":
          return "⌃";
        case "alt":
          return "⌥";
        case "shift":
          return "⇧";
        case "ArrowLeft":
          return "←";
        case "ArrowRight":
          return "→";
        case "ArrowUp":
          return "↑";
        case "ArrowDown":
          return "↓";
        case "Enter":
          return "↵";
        case "Backspace":
          return "⌫";
        case "Escape":
          return "Esc";
        case "Tab":
          return "⇥";
        default:
          return p.toUpperCase();
      }
    })
    .join("");
}

export function useKeymap() {
  const [keys, setKeys] = useState<KeyMap>(() => {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? { ...DEFAULT_KEYS, ...JSON.parse(raw) } : DEFAULT_KEYS;
    } catch {
      return DEFAULT_KEYS;
    }
  });

  const persist = useCallback((next: KeyMap) => {
    setKeys(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);

  const setBinding = useCallback(
    (action: ActionName, combo: string) => {
      persist({ ...keys, [action]: combo });
    },
    [keys, persist],
  );

  const resetBinding = useCallback(
    (action: ActionName) => {
      persist({ ...keys, [action]: DEFAULT_KEYS[action] });
    },
    [keys, persist],
  );

  const resetAll = useCallback(() => persist(DEFAULT_KEYS), [persist]);

  /** Найти действие по комбинации. */
  const actionFor = useCallback(
    (combo: string): ActionName | null => {
      for (const [action, binding] of Object.entries(keys) as [ActionName, string][]) {
        if (binding === combo) return action;
      }
      return null;
    },
    [keys],
  );

  return { keys, setBinding, resetBinding, resetAll, actionFor };
}

/** Проверить, не занята ли комбинация другим действием. */
export function conflictOf(keys: KeyMap, action: ActionName, combo: string): ActionName | null {
  for (const [name, binding] of Object.entries(keys) as [ActionName, string][]) {
    if (name !== action && binding === combo) return name;
  }
  return null;
}

/** Подписка на нажатия с уже вычисленной комбинацией. */
export function useKeyboard(handler: (combo: string, ev: KeyboardEvent) => void, deps: unknown[]) {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const combo = eventToCombo(ev);
      if (!combo) return;
      handler(combo, ev);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
