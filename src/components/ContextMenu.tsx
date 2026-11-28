/** Контекстное меню для файла и для пустого места. */

import { useEffect, useRef } from "react";
import type { Dict } from "../i18n";
import type { ClipboardState } from "../types";

export type MenuTarget =
  | { kind: "entry"; path: string; isDir: boolean }
  | { kind: "empty" };

type Props = {
  t: Dict;
  x: number;
  y: number;
  target: MenuTarget;
  selectionSize: number;
  clipboard: ClipboardState | null;
  isFavorite: boolean;
  dualPane: boolean;
  onClose: () => void;
  onOpen: () => void;
  onReveal: () => void;
  onRename: () => void;
  onTrash: () => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onRefresh: () => void;
  onToggleFavorite: () => void;
  onOpenInOtherPane: () => void;
  onNewWindow: () => void;
  onToggleHidden: () => void;
};

export function ContextMenu(props: Props) {
  const { t, x, y, target, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) onClose();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Не даём меню выехать за пределы окна.
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 230),
    top: Math.min(y, window.innerHeight - 340),
  };

  const Item = ({
    label,
    onClick,
    disabled,
    danger,
    ico,
  }: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
    ico?: string;
  }) => (
    <button
      className={"menu-item" + (danger ? " danger" : "")}
      disabled={disabled}
      onClick={() => {
        onClose();
        onClick();
      }}
    >
      {ico && <span className="menu-ico">{ico}</span>} {label}
    </button>
  );

  const Sep = () => <div className="menu-sep" />;

  return (
    <div className="menu ctx-menu" ref={ref} style={style}>
      {target.kind === "entry" ? (
        <>
          <Item label={t.open} onClick={props.onOpen} ico="↗" />
          <Item label={t.revealInFinder} onClick={props.onReveal} ico="🔍" />
          <Sep />
          <Item
            label={
              props.selectionSize > 1
                ? `${t.copy} (${props.selectionSize})`
                : t.copy
            }
            onClick={props.onCopy}
            ico="⧉"
          />
          <Item
            label={props.selectionSize > 1 ? `${t.cut} (${props.selectionSize})` : t.cut}
            onClick={props.onCut}
            ico="✂"
          />
          <Item label={t.paste} onClick={props.onPaste} disabled={!props.clipboard} ico="📥" />
          <Sep />
          <Item
            label={t.rename}
            onClick={props.onRename}
            disabled={props.selectionSize > 1}
            ico="✎"
          />
          <Item label={t.trash} onClick={props.onTrash} danger ico="🗑" />
          <Sep />
          <Item
            label={props.isFavorite ? t.removeFromFavorites : t.addToFavorites}
            onClick={props.onToggleFavorite}
            ico="★"
          />
          {target.isDir && props.dualPane && (
            <Item label={t.openInOtherPane} onClick={props.onOpenInOtherPane} ico="⇄" />
          )}
          {target.isDir && <Item label={t.newWindow} onClick={props.onNewWindow} ico="▤" />}
        </>
      ) : (
        <>
          <Item label={t.newFolder} onClick={props.onNewFolder} ico="📁" />
          <Item label={t.newFile} onClick={props.onNewFile} ico="📄" />
          <Sep />
          <Item label={t.paste} onClick={props.onPaste} disabled={!props.clipboard} ico="📥" />
          <Sep />
          <Item label={t.refresh} onClick={props.onRefresh} ico="⟳" />
          <Item label={t.showHidden} onClick={props.onToggleHidden} ico="👁" />
          <Item label={t.newWindow} onClick={props.onNewWindow} ico="▤" />
        </>
      )}
    </div>
  );
}
