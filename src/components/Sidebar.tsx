/** Левая панель: места, диски, избранное. */

import type { Dict } from "../i18n";
import { fmtSizeWith, placeLabel } from "../format";
import type { DiskInfo, Favorite } from "../types";

type Props = {
  places: DiskInfo[];
  disks: DiskInfo[];
  favorites: Favorite[];
  currentPath: string | undefined;
  t: Dict;
  onGo: (path: string) => void;
  onRemoveFavorite: (path: string) => void;
};

export function Sidebar({ places, disks, favorites, currentPath, t, onGo, onRemoveFavorite }: Props) {
  const fmtSize = fmtSizeWith(t);
  return (
    <aside className="sidebar">
      <div className="side-title">{t.places}</div>
      {places.map((p) => (
        <button
          key={p.mount}
          className={"side-item" + (currentPath === p.mount ? " active" : "")}
          onClick={() => onGo(p.mount)}
        >
          <span className="side-ico">{p.ico}</span>
          {placeLabel(p.label, t)}
        </button>
      ))}

      {favorites.length > 0 && (
        <>
          <div className="side-title" style={{ marginTop: 18 }}>
            {t.favorites}
          </div>
          {favorites.map((f) => (
            <button
              key={f.path}
              className={"side-item" + (currentPath === f.path ? " active" : "")}
              onClick={() => onGo(f.path)}
              onContextMenu={(ev) => {
                ev.preventDefault();
                onRemoveFavorite(f.path);
              }}
              title={f.path}
            >
              <span className="side-ico">★</span>
              <span className="disk-name">{f.name}</span>
            </button>
          ))}
        </>
      )}

      <div className="side-title" style={{ marginTop: 18 }}>
        {t.disks}
      </div>
      {disks.map((d) => (
        <div key={d.mount} className="disk-group">
          <button
            className={"side-item" + (currentPath === d.mount ? " active" : "")}
            onClick={() => onGo(d.mount)}
          >
            <span className="side-ico">{d.removable ? "💾" : "🖥"}</span>
            <span className="disk-name">{d.label}</span>
          </button>
          {d.total > 0 && (
            <div className="disk-bar">
              <div className="disk-track">
                <div
                  className="disk-fill"
                  style={{ width: `${Math.min(100, ((d.total - d.available) / d.total) * 100)}%` }}
                />
              </div>
              <div className="disk-label">
                {fmtSize(d.available)} {t.freeOf} {fmtSize(d.total)}
              </div>
            </div>
          )}
        </div>
      ))}
    </aside>
  );
}
