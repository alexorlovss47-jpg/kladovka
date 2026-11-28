/** Диалог дополнительных действий: архив, переименование, сравнение, размер. */

import { useEffect, useState } from "react";
import type { Dict } from "../i18n";
import { fmtSizeWith } from "../format";
import { useExtras } from "../hooks/useExtras";
import type { RenamePlan } from "../types";

type Props = {
  t: Dict;
  root: string;
  selection: string[];
  onClose: () => void;
  onRefresh: () => void;
};

type Mode = "archive" | "rename" | "compare" | "size";

export function ExtrasDialog({ t, root, selection, onClose, onRefresh }: Props) {
  const [mode, setMode] = useState<Mode>("archive");
  const [archiveName, setArchiveName] = useState("archive.zip");
  const [pattern, setPattern] = useState("file_{n}");
  const [start, setStart] = useState(1);
  const [nameFilter, setNameFilter] = useState("");
  const [extFilter, setExtFilter] = useState("");
  const [plan, setPlan] = useState<RenamePlan[] | null>(null);
  const [other, setOther] = useState(root);
  const [diff, setDiff] = useState<import("../types").DirDiff | null>(null);
  const [size, setSize] = useState<import("../types").FolderSize | null>(null);
  const extras = useExtras();
  const fmtSize = fmtSizeWith(t);

  // Сброс при смене вкладки.
  useEffect(() => {
    extras.clear();
    setPlan(null);
    setDiff(null);
    setSize(null);
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const doPlan = async () => {
    const p = await extras.planRename(selection, pattern, start, nameFilter || undefined, extFilter || undefined);
    setPlan(p);
  };

  const doApply = async () => {
    if (!plan) return;
    const n = await extras.applyRename(plan);
    if (n !== null && n > 0) {
      onRefresh();
      setPlan(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal extras-modal" onClick={(ev) => ev.stopPropagation()}>
        <div className="modal-title">{t.extraMenu}</div>

        <div className="sd-tabs">
          {([
            ["archive", t.extraArchive, "🗜"],
            ["rename", t.extraRename, "✎"],
            ["compare", t.extraCompare, "⇄"],
            ["size", t.extraFolderSize, "📊"],
          ] as const).map(([m, label, ico]) => (
            <button
              key={m}
              className={"sd-tab" + (mode === m ? " active" : "")}
              onClick={() => setMode(m)}
            >
              {ico} {label}
            </button>
          ))}
        </div>

        {mode === "archive" && (
          <>
            <p className="pv-dim">
              {t.archiveHint} · {t.renameSelected}: {selection.length}
            </p>
            <div className="sd-row">
              <label className="sd-label">{t.archiveName}</label>
              <input
                className="sd-input"
                value={archiveName}
                onChange={(e) => setArchiveName(e.target.value)}
              />
            </div>
            <div className="modal-actions">
              <button
                className="act primary"
                disabled={extras.busy || !selection.length || !archiveName.trim()}
                onClick={async () => {
                  const dest = root + "/" + (archiveName.endsWith(".zip") ? archiveName : archiveName + ".zip");
                  const r = await extras.archive(selection, dest);
                  if (r) onRefresh();
                }}
              >
                {extras.busy ? t.extraBusy : t.archiveRun}
              </button>
              <button className="act" onClick={() => extras.copyPath(root)}>
                {t.extraCopyPath}
              </button>
            </div>
          </>
        )}

        {mode === "rename" && (
          <>
            <p className="pv-dim">
              {t.renameSelected}: {selection.length}
            </p>
            <div className="sd-row">
              <label className="sd-label">{t.renamePattern}</label>
              <input
                className="sd-input"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="photo_{n}"
              />
            </div>
            <div className="sd-row">
              <label className="sd-label">{t.renameStart}</label>
              <input
                className="sd-num"
                type="number"
                min={0}
                value={start}
                onChange={(e) => setStart(Number(e.target.value) || 0)}
              />
            </div>
            <div className="sd-row">
              <label className="sd-label">{t.renameFilterName}</label>
              <input
                className="sd-input"
                value={nameFilter}
                onChange={(e) => setNameFilter(e.target.value)}
              />
            </div>
            <div className="sd-row">
              <label className="sd-label">{t.renameFilterExt}</label>
              <input
                className="sd-input"
                value={extFilter}
                onChange={(e) => setExtFilter(e.target.value)}
                placeholder="png"
              />
            </div>
            <div className="modal-actions">
              <button className="act" onClick={() => void doPlan()} disabled={extras.busy || !selection.length}>
                {t.renamePreview}
              </button>
              <button className="act primary" onClick={() => void doApply()} disabled={!plan || extras.busy}>
                {t.renameRun}
              </button>
            </div>
            {plan && (
              <div className="sd-list">
                {plan.map((p, i) => (
                  <div key={i} className="sd-item">
                    <span className="sd-item-name" title={p.from}>
                      {p.from.split("/").pop()}
                    </span>
                    <span className="pv-dim">→</span>
                    <span className="sd-item-name" title={p.to}>
                      {p.to.split("/").pop()}
                    </span>
                    {p.conflict && <span className="sd-conflict">{t.renameConflict}</span>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {mode === "compare" && (
          <>
            <div className="sd-row">
              <label className="sd-label">{t.compareLeft}</label>
              <input className="sd-input" value={root} readOnly />
            </div>
            <div className="sd-row">
              <label className="sd-label">{t.compareRight}</label>
              <input
                className="sd-input"
                value={other}
                onChange={(e) => setOther(e.target.value)}
                placeholder="/path/to/folder"
              />
            </div>
            <div className="modal-actions">
              <button
                className="act primary"
                disabled={extras.busy || !other.trim()}
                onClick={async () => setDiff(await extras.compare(root, other.trim()))}
              >
                {extras.busy ? t.extraBusy : t.compareRun}
              </button>
            </div>
            {diff && (
              <div className="sd-results">
                <div className="sd-summary">
                  {t.compareOnlyLeft}: {diff.only_left} · {t.compareOnlyRight}: {diff.only_right} ·{" "}
                  {t.compareDifferent}: {diff.different} · {t.compareSame}: {diff.same}
                </div>
                <div className="sd-list">
                  {diff.entries.map((e) => (
                    <div key={e.relative} className="sd-item">
                      <span className="sd-conflict">
                        {e.kind === "OnlyLeft"
                          ? "←"
                          : e.kind === "OnlyRight"
                            ? "→"
                            : "≠"}
                      </span>
                      <span className="sd-item-name" title={e.relative}>
                        {e.relative}
                      </span>
                      <span className="sd-item-size">
                        {e.left_size !== null ? fmtSize(e.left_size) : "—"} /{" "}
                        {e.right_size !== null ? fmtSize(e.right_size) : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {mode === "size" && (
          <>
            <p className="pv-dim">{root}</p>
            <div className="modal-actions">
              <button
                className="act primary"
                disabled={extras.busy}
                onClick={async () => setSize(await extras.folderSize(root))}
              >
                {extras.busy ? t.extraBusy : t.extraFolderSize}
              </button>
              <button className="act" onClick={() => void extras.copyPath(root)}>
                {t.extraCopyPath}
              </button>
            </div>
            {size && (
              <div className="pv-info">
                <dl className="pv-list">
                  <dt>{t.folderSizeBytes}</dt>
                  <dd>{fmtSize(size.bytes)}</dd>
                  <dt>{t.folderSizeFiles}</dt>
                  <dd>{size.files}</dd>
                  <dt>{t.folderSizeDirs}</dt>
                  <dd>{size.dirs}</dd>
                </dl>
              </div>
            )}
          </>
        )}

        {(extras.error || extras.message) && (
          <div className={extras.error ? "pv-error" : "pv-dim"}>
            {extras.error ?? extras.message}
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
