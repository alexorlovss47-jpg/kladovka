/** Диалог при совпадении имён: переименовать, пропустить, заменить. */

import type { Dict } from "../i18n";
import type { ConflictPolicy } from "../types";

type Props = {
  t: Dict;
  onChoose: (policy: ConflictPolicy) => void;
  onCancel: () => void;
};

export function ConflictDialog({ t, onChoose, onCancel }: Props) {
  const options: [ConflictPolicy, string, boolean][] = [
    ["rename", t.conflictRename, false],
    ["skip", t.conflictSkip, false],
    ["overwrite", t.conflictOverwrite, true],
  ];

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(ev) => ev.stopPropagation()}>
        <div className="modal-title">{t.conflictTitle}</div>
        <div className="conflict-body">{t.conflictBody}</div>
        <div className="conflict-opts">
          {options.map(([policy, label, danger]) => (
            <button
              key={policy}
              className={"act" + (danger ? " danger" : "")}
              onClick={() => onChoose(policy)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="conflict-warn">{t.conflictOverwriteWarn}</div>
        <div className="modal-actions">
          <button className="act" onClick={onCancel}>
            {t.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
