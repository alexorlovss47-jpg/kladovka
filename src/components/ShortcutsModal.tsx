/** Справка по горячим клавишам. */

import type { Dict } from "../i18n";

type Props = {
  t: Dict;
  onClose: () => void;
};

const Row = ({ keys, label }: { keys: string; label: string }) => (
  <div className="sc-row">
    <span>{keys}</span>
    <span>{label}</span>
  </div>
);

export function ShortcutsModal({ t, onClose }: Props) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal shortcuts-modal" onClick={(ev) => ev.stopPropagation()}>
        <div className="modal-title">{t.shortcuts}</div>
        <div className="sc-grid">
          <div>
            <div className="sc-title">{t.shortcutsNav}</div>
            <Row keys="↑ ↓" label={t.scUp} />
            <Row keys="↵" label={t.scOpen} />
            <Row keys="⌫" label={t.scUpDir} />
            <Row keys="← →" label={t.scHistory} />
          </div>
          <div>
            <div className="sc-title">{t.shortcutsSelect}</div>
            <Row keys={t.scAddKey} label={t.scAdd} />
            <Row keys={t.scRangeKey} label={t.scRange} />
            <Row keys="⌘A" label={t.scAll} />
            <Row keys="Esc" label={t.scClear} />
          </div>
          <div>
            <div className="sc-title">{t.shortcutsActions}</div>
            <Row keys="⌘C" label={t.scCopy} />
            <Row keys="⌘X" label={t.scCut} />
            <Row keys="⌘V" label={t.scPaste} />
            <Row keys="⌘⌫" label={t.scTrash} />
            <Row keys="F2" label={t.scRename} />
          </div>
          <div>
            <div className="sc-title">{t.shortcutsMisc}</div>
            <Row keys="⌘F" label={t.scSearch} />
            <Row keys="?" label={t.scHelp} />
          </div>
        </div>
        <div className="modal-actions">
          <button className="act primary" onClick={onClose}>
            {t.close}
          </button>
        </div>
      </div>
    </div>
  );
}
