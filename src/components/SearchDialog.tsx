/** Диалог поиска: расширенный фильтр, дубликаты, крупные файлы. */

import { useState } from "react";
import type { Dict } from "../i18n";
import { fmtSizeWith, iconFor } from "../format";
import type { DuplicateGroup, Entry, SearchFilter, SearchResult } from "../types";

type Props = {
  t: Dict;
  root: string;
  filter: SearchFilter;
  result: SearchResult | null;
  duplicates: DuplicateGroup[] | null;
  largest: Entry[] | null;
  searching: boolean;
  error: string | null;
  onFilterChange: (f: SearchFilter) => void;
  onSearch: () => void;
  onFindDuplicates: () => void;
  onFindLargest: () => void;
  onClear: () => void;
  onReveal: (path: string) => void;
  onGoTo: (path: string) => void;
  onClose: () => void;
};

type Mode = "filter" | "duplicates" | "largest";

const SIZE_STEPS = [
  { label: "0", value: 0 },
  { label: "1 KB", value: 1024 },
  { label: "100 KB", value: 100 * 1024 },
  { label: "1 MB", value: 1024 * 1024 },
  { label: "10 MB", value: 10 * 1024 * 1024 },
  { label: "100 MB", value: 100 * 1024 * 1024 },
  { label: "1 GB", value: 1024 * 1024 * 1024 },
];

const PERIODS: { key: "any" | "day" | "week" | "month" | "year"; days: number }[] = [
  { key: "any", days: 0 },
  { key: "day", days: 1 },
  { key: "week", days: 7 },
  { key: "month", days: 30 },
  { key: "year", days: 365 },
];

export function SearchDialog({
  t,
  root,
  filter,
  result,
  duplicates,
  largest,
  searching,
  error,
  onFilterChange,
  onSearch,
  onFindDuplicates,
  onFindLargest,
  onClear,
  onReveal,
  onGoTo,
  onClose,
}: Props) {
  const [mode, setMode] = useState<Mode>("filter");
  const fmtSize = fmtSizeWith(t);

  /** Ближайший период по значению modified_after. */
  const currentPeriod = (): string => {
    if (!filter.modified_after) return "any";
    const days = Math.round((Math.floor(Date.now() / 1000) - filter.modified_after) / 86400);
    if (days <= 1) return "day";
    if (days <= 7) return "week";
    if (days <= 30) return "month";
    return "year";
  };

  const setPeriod = (days: number) => {
    onFilterChange({
      ...filter,
      modified_after: days === 0 ? null : Math.floor(Date.now() / 1000) - days * 86400,
      modified_before: null,
    });
  };

  const sizeToValue = (v: number) => (v === 0 ? null : v);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal search-modal" onClick={(ev) => ev.stopPropagation()}>
        <div className="modal-title">{t.searchTitle}</div>
        <div className="sd-root" title={root}>
          {t.searchIn} {root}
        </div>

        <div className="sd-tabs">
          {([
            ["filter", t.searchTabFilter],
            ["duplicates", t.searchTabDuplicates],
            ["largest", t.searchTabLargest],
          ] as const).map(([m, label]) => (
            <button
              key={m}
              className={"sd-tab" + (mode === m ? " active" : "")}
              onClick={() => {
                setMode(m);
                onClear();
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "filter" && (
          <>
            <div className="sd-row">
              <label className="sd-label">{t.searchName}</label>
              <input
                className="sd-input"
                value={filter.query}
                onChange={(e) => onFilterChange({ ...filter, query: e.target.value })}
                placeholder={t.searchPlaceholder}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSearch();
                }}
              />
            </div>

            <div className="sd-row">
              <label className="sd-label">{t.searchExt}</label>
              <input
                className="sd-input"
                value={filter.extension ?? ""}
                onChange={(e) =>
                  onFilterChange({ ...filter, extension: e.target.value.trim() || null })
                }
                placeholder="png, pdf, rs…"
              />
            </div>

            <div className="sd-row">
              <label className="sd-label">{t.searchSize}</label>
              <div className="sd-inline">
                <select
                  className="sd-select"
                  value={filter.min_size ?? 0}
                  onChange={(e) =>
                    onFilterChange({ ...filter, min_size: sizeToValue(Number(e.target.value)) })
                  }
                >
                  {SIZE_STEPS.map((s) => (
                    <option key={s.value} value={s.value}>
                      от {s.label}
                    </option>
                  ))}
                </select>
                <select
                  className="sd-select"
                  value={filter.max_size ?? 0}
                  onChange={(e) =>
                    onFilterChange({ ...filter, max_size: sizeToValue(Number(e.target.value)) })
                  }
                >
                  {SIZE_STEPS.map((s) => (
                    <option key={s.value} value={s.value}>
                      до {s.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="sd-row">
              <label className="sd-label">{t.searchPeriod}</label>
              <div className="lang-opts">
                {PERIODS.map((p) => (
                  <button
                    key={p.key}
                    className={"lang-btn" + (currentPeriod() === p.key ? " active" : "")}
                    onClick={() => setPeriod(p.days)}
                  >
                    {p.key === "any"
                      ? t.searchPeriodAny
                      : p.key === "day"
                        ? t.searchPeriodDay
                        : p.key === "week"
                          ? t.searchPeriodWeek
                          : p.key === "month"
                            ? t.searchPeriodMonth
                            : t.searchPeriodYear}
                  </button>
                ))}
              </div>
            </div>

            <div className="sd-row">
              <label className="sd-label">{t.searchKind}</label>
              <div className="lang-opts">
                <button
                  className={"lang-btn" + (filter.include_files && filter.include_dirs ? " active" : "")}
                  onClick={() => onFilterChange({ ...filter, include_files: true, include_dirs: true })}
                >
                  {t.searchKindAll}
                </button>
                <button
                  className={"lang-btn" + (filter.include_files && !filter.include_dirs ? " active" : "")}
                  onClick={() => onFilterChange({ ...filter, include_files: true, include_dirs: false })}
                >
                  {t.searchKindFiles}
                </button>
                <button
                  className={"lang-btn" + (!filter.include_files && filter.include_dirs ? " active" : "")}
                  onClick={() => onFilterChange({ ...filter, include_files: false, include_dirs: true })}
                >
                  {t.searchKindDirs}
                </button>
              </div>
            </div>

            <div className="sd-row">
              <label className="sd-label">{t.searchOptions}</label>
              <div className="lang-opts">
                <button
                  className={"lang-btn" + (filter.include_hidden ? " active" : "")}
                  onClick={() => onFilterChange({ ...filter, include_hidden: !filter.include_hidden })}
                >
                  {t.searchHidden}
                </button>
                <label className="sd-depth">
                  {t.searchDepth}
                  <input
                    className="sd-num"
                    type="number"
                    min={1}
                    max={64}
                    value={filter.max_depth >= 999 ? 20 : filter.max_depth}
                    onChange={(e) =>
                      onFilterChange({
                        ...filter,
                        max_depth: Math.max(1, Math.min(64, Number(e.target.value) || 20)),
                      })
                    }
                  />
                </label>
              </div>
            </div>

            <div className="modal-actions">
              <button className="act" onClick={onClear}>
                {t.searchReset}
              </button>
              <button className="act primary" onClick={onSearch} disabled={searching}>
                {searching ? t.searching : t.searchRun}
              </button>
            </div>
          </>
        )}

        {mode !== "filter" && (
          <div className="sd-action-row">
            <button
              className="act primary"
              onClick={mode === "duplicates" ? onFindDuplicates : onFindLargest}
              disabled={searching}
            >
              {searching
                ? t.searching
                : mode === "duplicates"
                  ? t.searchFindDuplicates
                  : t.searchFindLargest}
            </button>
            <span className="pv-dim">
              {mode === "duplicates" ? t.searchDuplicatesHint : t.searchLargestHint}
            </span>
          </div>
        )}

        {error && <div className="pv-error">{error}</div>}

        {mode === "filter" && result && (
          <div className="sd-results">
            <div className="sd-summary">
              {t.searchFound} {result.entries.length}
              {result.truncated ? ` (${t.searchTruncated})` : ""} · {t.searchScanned}{" "}
              {result.scanned}
            </div>
            <div className="sd-list">
              {result.entries.map((e) => (
                <div
                  key={e.path}
                  className="sd-item"
                  onDoubleClick={() => onGoTo(e.path)}
                  title={e.path}
                >
                  <span className="ico">{iconFor(e)}</span>
                  <span className="sd-item-name">{e.name}</span>
                  <span className="sd-item-size">{e.is_dir ? "—" : fmtSize(e.size)}</span>
                  <button
                    className="sd-reveal"
                    onClick={() => onReveal(e.path)}
                    title={t.revealInFinder}
                  >
                    ⤴
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {mode === "duplicates" && duplicates && (
          <div className="sd-results">
            <div className="sd-summary">
              {duplicates.length} {t.searchGroups}
            </div>
            <div className="sd-list">
              {duplicates.map((g, gi) => (
                <div key={gi} className="dup-group">
                  <div className="dup-head">
                    {t.searchDuplicatesGroup} {gi + 1} · {fmtSize(g.size)} × {g.entries.length}
                  </div>
                  {g.entries.map((e) => (
                    <div key={e.path} className="sd-item" title={e.path}>
                      <span className="ico">📄</span>
                      <span className="sd-item-name">{e.path}</span>
                      <button className="sd-reveal" onClick={() => onReveal(e.path)}>
                        ⤴
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {mode === "largest" && largest && (
          <div className="sd-results">
            <div className="sd-summary">
              {t.searchLargestTop} {largest.length}
            </div>
            <div className="sd-list">
              {largest.map((e, i) => (
                <div key={e.path} className="sd-item" title={e.path}>
                  <span className="sd-rank">{i + 1}</span>
                  <span className="ico">{iconFor(e)}</span>
                  <span className="sd-item-name">{e.name}</span>
                  <span className="sd-item-size">{fmtSize(e.size)}</span>
                  <button className="sd-reveal" onClick={() => onReveal(e.path)}>
                    ⤴
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="act" onClick={onClose}>
            {t.close}
          </button>
        </div>
      </div>
    </div>
  );
}
