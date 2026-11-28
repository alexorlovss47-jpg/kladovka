/** Справка по горячим клавишам — показывает текущие сочетания. */

import type { Dict } from "../i18n";
import { prettyCombo, type KeyMap } from "../hooks/useKeymap";
import type { ActionName } from "../types";

type Props = {
  t: Dict;
  keys?: KeyMap;
  onClose: () => void;
};

const Row = ({ keys, label }: { keys: string; label: string }) => (
  <div className="sc-row">
    <span>{keys}</span>
    <span>{label}</span>
  </div>
);

const K = (combo: string | undefined, fallback: string) =>
  combo ? prettyCombo(combo) : fallback;

export function ShortcutsModal({ t, keys, onClose }: Props) {
  const k = (action: ActionName, fallback: string) =>
    keys ? K(keys[action], fallback) : fallback;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal shortcuts-modal" onClick={(ev) => ev.stopPropagation()}>
        <div className="modal-title">{t.shortcuts}</div>
        <div className="sc-grid">
          <div>
            <div className="sc-title">{t.shortcutsNav}</div>
            <Row keys="↑ ↓" label={t.scUp} />
            <Row keys={k("openEntry", "↵")} label={t.scOpen} />
            <Row keys={k("goUp", "⌫")} label={t.scUpDir} />
            <Row keys={`${k("goBack", "←")} ${k("goForward", "→")}`} label={t.scHistory} />
            <Row keys="Esc" label={t.scClear} />
          </div>
          <div>
            <div className="sc-title">{t.shortcutsSelect}</div>
            <Row keys={t.scAddKey} label={t.scAdd} />
            <Row keys={t.scRangeKey} label={t.scRange} />
            <Row keys={k("selectAll", "⌘A")} label={t.scAll} />
            <Row keys={k("focusSearch", "⌘F")} label={t.scSearch} />
          </div>
          <div>
            <div className="sc-title">{t.shortcutsActions}</div>
            <Row keys={k("copy", "⌘C")} label={t.scCopy} />
            <Row keys={k("cut", "⌘X")} label={t.scCut} />
            <Row keys={k("paste", "⌘V")} label={t.paste} />
            <Row keys={k("trash", "⌘⌫")} label={t.scTrash} />
            <Row keys={k("rename", "F2")} label={t.scRename} />
            <Row keys={k("newFolder", "⌘⇧N")} label={t.newFolder} />
          </div>
          <div>
            <div className="sc-title">{t.shortcutsMisc}</div>
            <Row keys={k("newTab", "⌘T")} label={t.newTab} />
            <Row keys={k("closeTab", "⌘W")} label={t.closeTab} />
            <Row keys={`${k("prevTab", "⌘⌥←")} ${k("nextTab", "⌘⌥→")}`} label={`${t.prevTab} / ${t.nextTab}`} />
            <Row keys={k("focusOtherPane", "F6")} label={t.focusOtherPane} />
            <Row keys={k("toggleDualPane", "⌘⇧D")} label={t.toggleDualPane} />
            <Row keys={k("newWindow", "⌘N")} label={t.newWindow} />
            <Row keys={k("toggleHidden", "⌘⇧H")} label={t.toggleHidden} />
            <Row keys={k("refresh", "⌘R")} label={t.refresh} />
            <Row keys={k("help", "?")} label={t.scHelp} />
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
