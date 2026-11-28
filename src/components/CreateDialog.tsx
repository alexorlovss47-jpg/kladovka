/** Диалог создания файла/папки. */

import type { Dict } from "../i18n";
import type { NewItemDialog } from "../types";

type Props = {
  t: Dict;
  dialog: NewItemDialog;
  onChange: (v: NewItemDialog) => void;
  onCommit: () => void;
  onCancel: () => void;
};

export function CreateDialog({ t, dialog, onChange, onCommit, onCancel }: Props) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(ev) => ev.stopPropagation()}>
        <div className="modal-title">{dialog.kind === "dir" ? t.newFolderTitle : t.newFileTitle}</div>
        <input
          className="modal-input"
          autoFocus
          value={dialog.value}
          onChange={(ev) => onChange({ ...dialog, value: ev.target.value })}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") onCommit();
            if (ev.key === "Escape") onCancel();
          }}
        />
        <div className="modal-actions">
          <button className="act" onClick={onCancel}>
            {t.cancel}
          </button>
          <button className="act primary" onClick={onCommit}>
            {t.create2}
          </button>
        </div>
      </div>
    </div>
  );
}
