/** Настройка горячих клавиш: список действий с переназначением. */

import { useState } from "react";
import type { Dict } from "../i18n";
import {
  conflictOf,
  eventToCombo,
  prettyCombo,
  DEFAULT_KEYS,
  type KeyMap,
} from "../hooks/useKeymap";
import type { ActionName } from "../types";

type Props = {
  t: Dict;
  keys: KeyMap;
  onSet: (action: ActionName, combo: string) => void;
  onReset: (action: ActionName) => void;
  onResetAll: () => void;
  onClose: () => void;
};

const LABEL: Record<ActionName, keyof Dict> = {
  newTab: "actionNewTab",
  closeTab: "actionCloseTab",
  nextTab: "actionNextTab",
  prevTab: "actionPrevTab",
  focusOtherPane: "actionFocusOtherPane",
  toggleDualPane: "actionToggleDualPane",
  newWindow: "actionNewWindow",
  newFolder: "actionNewFolder",
  goUp: "actionGoUp",
  goBack: "actionGoBack",
  goForward: "actionGoForward",
  openEntry: "actionOpenEntry",
  rename: "actionRename",
  trash: "actionTrash",
  selectAll: "actionSelectAll",
  copy: "actionCopy",
  cut: "actionCut",
  paste: "actionPaste",
  focusSearch: "actionFocusSearch",
  help: "actionHelp",
  refresh: "actionRefresh",
  toggleHidden: "actionToggleHidden",
  togglePreview: "actionTogglePreview",
  advancedSearch: "actionAdvancedSearch",
};

export function KeymapModal({ t, keys, onSet, onReset, onResetAll, onClose }: Props) {
  const [listening, setListening] = useState<ActionName | null>(null);

  const startListen = (action: ActionName) => {
    setListening(action);
    const handler = (ev: KeyboardEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.key === "Escape") {
        window.removeEventListener("keydown", handler, true);
        setListening(null);
        return;
      }
      const combo = eventToCombo(ev);
      if (!combo) return;
      window.removeEventListener("keydown", handler, true);
      setListening(null);
      const taken = conflictOf(keys, action, combo);
      if (taken) {
        // Занято — не перезаписываем молча, показываем пользователю.
        window.alert(`${t.keyConflict}: ${prettyCombo(combo)} → ${t[LABEL[taken]]}`);
        return;
      }
      onSet(action, combo);
    };
    window.addEventListener("keydown", handler, true);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal keymap-modal" onClick={(ev) => ev.stopPropagation()}>
        <div className="modal-title">{t.shortcutsConfig}</div>
        <div className="keymap-list">
          {(Object.keys(LABEL) as ActionName[]).map((action) => {
            const custom = keys[action] !== DEFAULT_KEYS[action];
            return (
              <div className="keymap-row" key={action}>
                <span className="keymap-label">{t[LABEL[action]]}</span>
                <button
                  className={"keymap-key" + (listening === action ? " listening" : "")}
                  onClick={() => startListen(action)}
                >
                  {listening === action ? t.pressKeys : prettyCombo(keys[action])}
                </button>
                <button
                  className="keymap-reset"
                  disabled={!custom}
                  onClick={() => onReset(action)}
                  title={t.resetKey}
                >
                  ↺
                </button>
              </div>
            );
          })}
        </div>
        <div className="modal-actions">
          <button className="act" onClick={onResetAll}>
            {t.resetAllKeys}
          </button>
          <button className="act primary" onClick={onClose}>
            {t.close}
          </button>
        </div>
      </div>
    </div>
  );
}
