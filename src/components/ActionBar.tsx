/** Нижняя панель действий и подсказки по выделению. */

import type { Dict } from "../i18n";
import type { ClipboardState } from "../types";

type Props = {
  t: Dict;
  selectionSize: number;
  totalSize: number;
  clipboard: ClipboardState | null;
  fmtSize: (n: number | null) => string;
  onCopy: () => void;
  onCut: () => void;
  onTrash: () => void;
  onRename: () => void;
  onReveal: () => void;
  onPaste: () => void;
};

export function ActionBar({
  t,
  selectionSize,
  totalSize,
  clipboard,
  fmtSize,
  onCopy,
  onCut,
  onTrash,
  onRename,
  onReveal,
  onPaste,
}: Props) {
  return (
    <div className="actions">
      {selectionSize > 0 ? (
        <>
          <button className="act" onClick={onCopy}>
            {t.copy}
          </button>
          <button className="act" onClick={onCut}>
            {t.cut}
          </button>
          <button className="act danger" onClick={onTrash}>
            {t.trash}
          </button>
          {selectionSize === 1 && (
            <>
              <button className="act" onClick={onRename}>
                {t.rename}
              </button>
              <button className="act" onClick={onReveal}>
                {t.revealInFinder}
              </button>
            </>
          )}
          {totalSize > 0 && <span className="hint">{fmtSize(totalSize)}</span>}
        </>
      ) : (
        <span className="hint">
          {clipboard
            ? `${t.clipboardHas}: ${clipboard.paths.length} (${clipboard.mode === "copy" ? t.copyWord : t.cutWord})`
            : t.hint}
        </span>
      )}
      {clipboard && (
        <button className="act" onClick={onPaste}>
          {t.pasteHere}
        </button>
      )}
    </div>
  );
}
