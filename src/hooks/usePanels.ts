/**
 * Панели и вкладки.
 *
 * Модель: массив панелей (1 или 2), в каждой — массив вкладок.
 * Каждая вкладка независима: своя история, листинг, поиск, сортировка и
 * выделение. Выделение живёт здесь, а не в App — иначе две панели делили бы
 * один Set и гасили друг друга.
 *
 * Все операции принимают panelId явно, поэтому один API обслуживает обе
 * панели и не зависит от того, какая из них сейчас активна.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { compareEntries } from "../format";
import type { DirListing, Entry, PanelState, SortDir, SortKey, TabState } from "../types";

let seq = 0;
const uid = () => `t${Date.now().toString(36)}-${(seq++).toString(36)}`;

function makeTab(path?: string): TabState {
  return {
    id: uid(),
    history: path ? [path] : [],
    histIdx: path ? 0 : -1,
    listing: null,
    loading: false,
    error: null,
    query: "",
    searchResults: null,
    sortKey: "name",
    sortDir: 1,
    selection: new Set<string>(),
    anchor: null,
  };
}

export function usePanels(showHidden: boolean, home: string | null) {
  const [panels, setPanels] = useState<PanelState[]>(() => {
    const t = makeTab();
    return [{ id: "p1", tabs: [t], activeTabId: t.id }];
  });
  const [activePanelId, setActivePanelId] = useState("p1");
  const [dualPane, setDualPane] = useState(false);

  const homeRef = useRef<string | null>(home);
  const loadedRef = useRef(new Set<string>());

  useEffect(() => {
    homeRef.current = home;
  }, [home]);

  const patchTab = useCallback((panelId: string, tabId: string, fn: (t: TabState) => TabState) => {
    setPanels((prev) =>
      prev.map((p) =>
        p.id !== panelId ? p : { ...p, tabs: p.tabs.map((t) => (t.id === tabId ? fn(t) : t)) },
      ),
    );
  }, []);

  // ---------- загрузка ----------
  const load = useCallback(
    async (panelId: string, tabId: string, path: string, pushHistory = true) => {
      patchTab(panelId, tabId, (t) => ({ ...t, loading: true, error: null }));
      try {
        const res = await invoke<DirListing>("list_dir", { path, showHidden });
        patchTab(panelId, tabId, (t) => {
          const last = t.history[t.history.length - 1];
          const push = pushHistory && last !== res.path;
          const history = push ? [...t.history, res.path] : t.history;
          return {
            ...t,
            listing: res,
            error: res.error,
            loading: false,
            searchResults: null,
            query: "",
            selection: new Set<string>(),
            anchor: null,
            history,
            histIdx: push ? history.length - 1 : Math.max(0, t.histIdx),
          };
        });
        return res;
      } catch (e) {
        patchTab(panelId, tabId, (t) => ({ ...t, loading: false, error: String(e) }));
        return null;
      }
    },
    [showHidden, patchTab],
  );

  // Первая загрузка всех вкладок, когда известен home.
  useEffect(() => {
    if (!home) return;
    for (const p of panels) {
      for (const t of p.tabs) {
        if (!t.listing && !t.loading && !loadedRef.current.has(t.id)) {
          loadedRef.current.add(t.id);
          void load(p.id, t.id, t.history[0] ?? home, t.history.length === 0);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home, panels]);

  // Смена фильтра скрытых: перечитать открытые вкладки.
  useEffect(() => {
    if (!home) return;
    for (const p of panels) {
      for (const t of p.tabs) {
        if (t.listing) void load(p.id, t.id, t.listing.path, false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  // ---------- навигация ----------
  const go = useCallback(
    (panelId: string, path: string) => {
      const p = panels.find((x) => x.id === panelId);
      if (p) void load(panelId, p.activeTabId, path, true);
    },
    [panels, load],
  );

  const goBack = useCallback(
    (panelId: string) => {
      const p = panels.find((x) => x.id === panelId);
      const t = p?.tabs.find((x) => x.id === p.activeTabId);
      if (!p || !t || t.histIdx <= 0) return;
      const i = t.histIdx - 1;
      patchTab(p.id, t.id, (old) => ({ ...old, histIdx: i }));
      void load(p.id, t.id, t.history[i], false);
    },
    [panels, patchTab, load],
  );

  const goForward = useCallback(
    (panelId: string) => {
      const p = panels.find((x) => x.id === panelId);
      const t = p?.tabs.find((x) => x.id === p.activeTabId);
      if (!p || !t || t.histIdx >= t.history.length - 1) return;
      const i = t.histIdx + 1;
      patchTab(p.id, t.id, (old) => ({ ...old, histIdx: i }));
      void load(p.id, t.id, t.history[i], false);
    },
    [panels, patchTab, load],
  );

  const goUp = useCallback(
    (panelId: string) => {
      const p = panels.find((x) => x.id === panelId);
      const t = p?.tabs.find((x) => x.id === p.activeTabId);
      if (p && t?.listing?.parent) void load(p.id, t.id, t.listing.parent, true);
    },
    [panels, load],
  );

  const refresh = useCallback(
    (panelId: string) => {
      const p = panels.find((x) => x.id === panelId);
      const t = p?.tabs.find((x) => x.id === p.activeTabId);
      if (p && t?.listing) void load(p.id, t.id, t.listing.path, false);
    },
    [panels, load],
  );

  const refreshAll = useCallback(() => {
    for (const p of panels) {
      for (const t of p.tabs) {
        if (t.listing) void load(p.id, t.id, t.listing.path, false);
      }
    }
  }, [panels, load]);

  // ---------- вкладки ----------
  const addTab = useCallback(
    (panelId: string, path?: string) => {
      const start = path ?? homeRef.current ?? undefined;
      const fresh = makeTab(start);
      setPanels((prev) =>
        prev.map((p) =>
          p.id !== panelId ? p : { ...p, tabs: [...p.tabs, fresh], activeTabId: fresh.id },
        ),
      );
      if (start) {
        loadedRef.current.add(fresh.id);
        void load(panelId, fresh.id, start, false);
      }
    },
    [load],
  );

  const closeTab = useCallback(
    (panelId: string, tabId: string) => {
      setPanels((prev) =>
        prev.map((p) => {
          if (p.id !== panelId || p.tabs.length <= 1) return p;
          const idx = p.tabs.findIndex((t) => t.id === tabId);
          if (idx < 0) return p;
          const tabs = p.tabs.filter((t) => t.id !== tabId);
          const activeTabId =
            p.activeTabId === tabId ? tabs[Math.min(idx, tabs.length - 1)].id : p.activeTabId;
          return { ...p, tabs, activeTabId };
        }),
      );
    },
    [],
  );

  const selectTab = useCallback((panelId: string, tabId: string) => {
    setPanels((prev) =>
      prev.map((p) => (p.id === panelId ? { ...p, activeTabId: tabId } : p)),
    );
  }, []);

  const cycleTab = useCallback(
    (panelId: string, dir: 1 | -1) => {
      const p = panels.find((x) => x.id === panelId);
      if (!p || p.tabs.length < 2) return;
      const idx = p.tabs.findIndex((t) => t.id === p.activeTabId);
      const next = (idx + dir + p.tabs.length) % p.tabs.length;
      setPanels((prev) =>
        prev.map((x) => (x.id === panelId ? { ...x, activeTabId: p.tabs[next].id } : x)),
      );
    },
    [panels],
  );

  // ---------- панели ----------
  const toggleDualPane = useCallback(() => {
    if (dualPane) {
      setDualPane(false);
      setPanels((prev) => prev.slice(0, 1));
      setActivePanelId("p1");
      return;
    }
    setDualPane(true);
    setPanels((prev) => {
      if (prev.length > 1) return prev;
      const t = makeTab(homeRef.current ?? undefined);
      if (t.history[0]) {
        loadedRef.current.add(t.id);
        void load("p2", t.id, t.history[0], false);
      }
      return [...prev, { id: "p2", tabs: [t], activeTabId: t.id }];
    });
  }, [dualPane, load]);

  const focusOtherPane = useCallback(() => {
    if (!dualPane) return;
    setActivePanelId((cur) => (cur === "p1" ? "p2" : "p1"));
  }, [dualPane]);

  // ---------- поиск ----------
  const search = useCallback(
    async (panelId: string, q: string) => {
      const p = panels.find((x) => x.id === panelId);
      const t = p?.tabs.find((x) => x.id === p.activeTabId);
      if (!p || !t?.listing) return;
      if (!q.trim()) {
        patchTab(p.id, t.id, (old) => ({ ...old, searchResults: null }));
        return;
      }
      try {
        const res = await invoke<Entry[]>("search_tree", {
          root: t.listing.path,
          query: q,
          limit: 300,
        });
        patchTab(p.id, t.id, (old) => ({ ...old, searchResults: res }));
      } catch (e) {
        patchTab(p.id, t.id, (old) => ({ ...old, error: String(e) }));
      }
    },
    [panels, patchTab],
  );

  // ---------- выделение / сортировка ----------
  const withActiveTab = useCallback(
    (panelId: string, fn: (t: TabState) => TabState) => {
      const p = panels.find((x) => x.id === panelId);
      if (p) patchTab(p.id, p.activeTabId, fn);
    },
    [panels, patchTab],
  );

  const clickEntry = useCallback(
    (panelId: string, e: Entry, ev: React.MouseEvent, list: Entry[]) => {
      withActiveTab(panelId, (t) => {
        const next = new Set(ev.metaKey || ev.ctrlKey ? t.selection : []);
        if (ev.shiftKey && t.anchor) {
          const paths = list.map((x) => x.path);
          const a = paths.indexOf(t.anchor);
          const b = paths.indexOf(e.path);
          if (a >= 0 && b >= 0) {
            for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(paths[i]);
          }
        } else if (next.has(e.path)) {
          next.delete(e.path);
        } else {
          next.add(e.path);
        }
        return { ...t, selection: next, anchor: e.path };
      });
    },
    [withActiveTab],
  );

  const setSelection = useCallback(
    (panelId: string, sel: Set<string>, anchor: string | null = null) => {
      withActiveTab(panelId, (t) => ({ ...t, selection: sel, anchor }));
    },
    [withActiveTab],
  );

  const clearSelection = useCallback(
    (panelId: string) => {
      withActiveTab(panelId, (t) => ({ ...t, selection: new Set<string>(), anchor: null }));
    },
    [withActiveTab],
  );

  const setSort = useCallback(
    (panelId: string, k: SortKey) => {
      withActiveTab(panelId, (t) =>
        t.sortKey === k
          ? { ...t, sortDir: (t.sortDir === 1 ? -1 : 1) as SortDir }
          : { ...t, sortKey: k, sortDir: (k === "name" ? 1 : -1) as SortDir },
      );
    },
    [withActiveTab],
  );

  const setQuery = useCallback(
    (panelId: string, q: string) => {
      withActiveTab(panelId, (t) => ({ ...t, query: q }));
    },
    [withActiveTab],
  );

  const setError = useCallback(
    (panelId: string, msg: string | null) => {
      withActiveTab(panelId, (t) => ({ ...t, error: msg }));
    },
    [withActiveTab],
  );

  /** Срез состояния конкретной панели: вкладка, сортированные записи. */
  const slice = useCallback(
    (panelId: string) => {
      const panel = panels.find((p) => p.id === panelId) ?? null;
      const tab = panel?.tabs.find((t) => t.id === panel.activeTabId) ?? null;
      const src = tab?.searchResults ?? tab?.listing?.entries ?? [];
      const entries = [...src].sort(
        compareEntries(tab?.sortKey ?? "name", tab?.sortDir ?? 1),
      );
      return { panel, tab, entries };
    },
    [panels],
  );

  const activePanel = panels.find((p) => p.id === activePanelId) ?? panels[0] ?? null;

  return {
    panels,
    activePanelId,
    setActivePanelId,
    activePanel,
    dualPane,
    toggleDualPane,
    focusOtherPane,
    load,
    go,
    goBack,
    goForward,
    goUp,
    refresh,
    refreshAll,
    addTab,
    closeTab,
    selectTab,
    cycleTab,
    search,
    clickEntry,
    setSelection,
    clearSelection,
    setSort,
    setQuery,
    setError,
    patchTab,
    slice,
  };
}

export type PanelsApi = ReturnType<typeof usePanels>;
