/** Полоса быстрых фильтров над списком файлов. */

import type { Dict } from "../i18n";
import type { QuickFilter } from "../types";

type Props = {
  t: Dict;
  filter: QuickFilter;
  total: number;
  shown: number;
  onChange: (f: QuickFilter) => void;
  onOpenAdvanced: () => void;
};

const SIZES: { label: string; value: number | null }[] = [
  { label: ">0", value: null },
  { label: ">1K", value: 1024 },
  { label: ">100K", value: 100 * 1024 },
  { label: ">1M", value: 1024 * 1024 },
  { label: ">10M", value: 10 * 1024 * 1024 },
  { label: ">100M", value: 100 * 1024 * 1024 },
];

export function FilterBar({ t, filter, total, shown, onChange, onOpenAdvanced }: Props) {
  const active =
    filter.ext !== "" || filter.minSize !== null || filter.period !== "all" || filter.kind !== "all";

  return (
    <div className={"filter-bar" + (active ? " active" : "")}>
      <span className="fb-label">{t.filterButton}</span>

      <input
        className="fb-input fb-ext"
        placeholder={t.filterExt}
        value={filter.ext}
        onChange={(e) => onChange({ ...filter, ext: e.target.value })}
      />

      <select
        className="fb-select"
        value={filter.minSize ?? ""}
        onChange={(e) =>
          onChange({ ...filter, minSize: e.target.value ? Number(e.target.value) : null })
        }
        title={t.filterSize}
      >
        {SIZES.map((s) => (
          <option key={s.label} value={s.value ?? ""}>
            {s.label}
          </option>
        ))}
      </select>

      <select
        className="fb-select"
        value={filter.period}
        onChange={(e) =>
          onChange({ ...filter, period: e.target.value as QuickFilter["period"] })
        }
        title={t.filterPeriod}
      >
        <option value="all">{t.filterAny}</option>
        <option value="day">{t.searchPeriodDay}</option>
        <option value="week">{t.searchPeriodWeek}</option>
        <option value="month">{t.searchPeriodMonth}</option>
        <option value="year">{t.searchPeriodYear}</option>
      </select>

      <select
        className="fb-select"
        value={filter.kind}
        onChange={(e) => onChange({ ...filter, kind: e.target.value as QuickFilter["kind"] })}
        title={t.filterKind}
      >
        <option value="all">{t.searchKindAll}</option>
        <option value="files">{t.searchKindFiles}</option>
        <option value="dirs">{t.searchKindDirs}</option>
      </select>

      {active && (
        <>
          <span className="fb-count">
            {t.filterShown} {shown} / {total}
          </span>
          <button
            className="fb-reset"
            onClick={() =>
              onChange({ ext: "", minSize: null, maxSize: null, period: "all", kind: "all" })
            }
            title={t.filterReset}
          >
            ✕
          </button>
        </>
      )}

      <button className="fb-advanced" onClick={onOpenAdvanced} title={t.searchTitle}>
        ⌕ {t.searchTitle}
      </button>
    </div>
  );
}
