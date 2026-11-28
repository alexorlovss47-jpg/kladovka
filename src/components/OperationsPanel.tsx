/** Панель операций: очередь, прогресс, скорость, ETA, пауза/отмена. */

import type { Dict } from "../i18n";
import { fmtSizeWith } from "../format";
import type { OpInfo, OpStatus } from "../types";

type Props = {
  t: Dict;
  active: OpInfo[];
  finished: OpInfo[];
  onPause: (id: number) => void;
  onResume: (id: number) => void;
  onCancel: (id: number) => void;
  onDismiss: (id: number) => void;
};

const statusLabel = (s: OpStatus, t: Dict): string => {
  switch (s) {
    case "queued":
      return t.opsQueued;
    case "running":
      return t.opsRunning;
    case "paused":
      return t.opsPaused;
    case "finished":
      return t.opsFinished;
    case "failed":
      return t.opsFailed;
    case "cancelled":
      return t.opsCancelled;
  }
};

const fmtEta = (secs: number | null): string => {
  if (secs === null || !isFinite(secs)) return "";
  if (secs < 60) return `${secs} с`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}:${String(s).padStart(2, "0")}`;
  return `${Math.floor(m / 60)}ч ${m % 60}м`;
};

export function OperationsPanel({ t, active, finished, onPause, onResume, onCancel, onDismiss }: Props) {
  const fmtSize = fmtSizeWith(t);
  const visible = [...active, ...finished.slice(-3).reverse()];
  if (!visible.length) return null;

  return (
    <div className="ops-panel">
      <div className="ops-head">{t.opsTitle}</div>
      {visible.map((op) => {
        const pct = op.total > 0 ? Math.min(100, (op.done / op.total) * 100) : 0;
        const isActive = op.status === "running" || op.status === "queued" || op.status === "paused";
        return (
          <div className={`op op-${op.status}`} key={op.id}>
            <div className="op-line">
              <span className="op-kind">{op.kind === "move" ? t.moving : t.copying}</span>
              <span className="op-status">{statusLabel(op.status, t)}</span>
              {op.status === "running" && op.bytes_per_sec > 0 && (
                <span className="op-stat">
                  {fmtSize(Math.round(op.bytes_per_sec))}/с
                  {op.eta_secs !== null ? ` · ${t.opsEta} ${fmtEta(op.eta_secs)}` : ""}
                </span>
              )}
              {op.files_total > 0 && (
                <span className="op-stat">
                  {op.files_done}/{op.files_total} {t.opsFiles}
                </span>
              )}
              <span className="op-btns">
                {op.status === "running" && (
                  <button className="op-btn" onClick={() => onPause(op.id)} title={t.opsPause}>
                    ⏸
                  </button>
                )}
                {op.status === "paused" && (
                  <button className="op-btn" onClick={() => onResume(op.id)} title={t.opsResume}>
                    ▶
                  </button>
                )}
                {isActive && (
                  <button className="op-btn danger" onClick={() => onCancel(op.id)} title={t.opsCancel}>
                    ✕
                  </button>
                )}
                {!isActive && (
                  <button className="op-btn" onClick={() => onDismiss(op.id)} title={t.opsDismiss}>
                    ✕
                  </button>
                )}
              </span>
            </div>
            <div className="op-track">
              <div className="op-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="op-sub">
              <span>
                {fmtSize(op.done)}
                {op.total > 0 ? ` / ${fmtSize(op.total)}` : ""}
              </span>
              {op.current && <span className="op-current">{op.current}</span>}
              {op.error && <span className="op-error">{op.error}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
