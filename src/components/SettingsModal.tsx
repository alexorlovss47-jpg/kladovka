/** Настройки: язык, тема, звуки. */

import type { Dict, Lang } from "../i18n";
import { playSound, saveSoundSettings, type SoundName, type SoundSettings } from "../sounds";
import type { ThemePref, ViewMode } from "../types";

type Props = {
  t: Dict;
  langPref: Lang | "auto";
  themePref: ThemePref;
  sounds: SoundSettings;
  viewMode: ViewMode;
  onLangChange: (v: Lang | "auto") => void;
  onThemeChange: (v: ThemePref) => void;
  onSoundsChange: (v: SoundSettings) => void;
  onViewModeChange: (v: ViewMode) => void;
  onOpenKeymap?: () => void;
  onClose: () => void;
};

const SOUND_ROWS: [SoundName, keyof Dict][] = [
  ["select", "soundSelect"],
  ["copy", "soundCopy"],
  ["move", "soundMove"],
  ["drop", "soundDrop"],
  ["error", "soundError"],
  ["rename", "soundRename"],
  ["new", "soundNew"],
];

export function SettingsModal({
  t,
  langPref,
  themePref,
  sounds,
  viewMode,
  onLangChange,
  onThemeChange,
  onSoundsChange,
  onViewModeChange,
  onOpenKeymap,
  onClose,
}: Props) {
  const update = (next: SoundSettings) => {
    onSoundsChange(next);
    saveSoundSettings(next);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(ev) => ev.stopPropagation()}>
        <div className="modal-title">{t.settings}</div>

        <div className="set-row">
          <span className="set-label">{t.language}</span>
          <div className="lang-opts">
            {(["auto", "ru", "en"] as const).map((v) => (
              <button
                key={v}
                className={"lang-btn" + (langPref === v ? " active" : "")}
                onClick={() => onLangChange(v)}
              >
                {v === "auto" ? t.languageAuto : v === "ru" ? t.languageRu : t.languageEn}
              </button>
            ))}
          </div>
        </div>

        <div className="set-row">
          <span className="set-label">{t.theme}</span>
          <div className="lang-opts">
            {(["auto", "light", "dark"] as const).map((v) => (
              <button
                key={v}
                className={"lang-btn" + (themePref === v ? " active" : "")}
                onClick={() => onThemeChange(v)}
              >
                {v === "auto" ? t.themeAuto : v === "light" ? t.themeLight : t.themeDark}
              </button>
            ))}
          </div>
        </div>

        <div className="set-row">
          <span className="set-label">{t.viewMode}</span>
          <div className="lang-opts">
            {([
              ["list", t.viewList, "☰"],
              ["grid", t.viewGrid, "▦"],
              ["compact", t.viewCompact, "≡"],
            ] as const).map(([v, label, ico]) => (
              <button
                key={v}
                className={"lang-btn" + (viewMode === v ? " active" : "")}
                onClick={() => onViewModeChange(v)}
              >
                {ico} {label}
              </button>
            ))}
          </div>
        </div>

        {onOpenKeymap && (
          <div className="set-row">
            <span className="set-label">{t.shortcutsConfig}</span>
            <div className="lang-opts">
              <button className="lang-btn" onClick={onOpenKeymap}>
                {t.shortcutsConfig}
              </button>
            </div>
          </div>
        )}

        <div className="set-row">
          <span className="set-label">{t.sounds}</span>
          <div className="lang-opts">
            <button
              className={"lang-btn" + (sounds.enabled ? " active" : "")}
              onClick={() => update({ ...sounds, enabled: !sounds.enabled })}
            >
              {sounds.enabled ? t.soundsOn : t.soundsOff}
            </button>
          </div>
        </div>

        {sounds.enabled && (
          <>
            <div className="set-row">
              <span className="set-label">
                {t.soundVolume} · {Math.round(sounds.volume * 100)}%
              </span>
              <input
                className="volume-slider"
                type="range"
                min={0}
                max={100}
                value={Math.round(sounds.volume * 100)}
                onChange={(e) => update({ ...sounds, volume: Number(e.target.value) / 100 })}
              />
            </div>
            {SOUND_ROWS.map(([name, key]) => (
              <div className="set-row sound-row" key={name}>
                <span className="sound-name">{t[key]}</span>
                <div className="lang-opts">
                  <button
                    className={"lang-btn" + (sounds.muted[name] ? "" : " active")}
                    onClick={() =>
                      update({ ...sounds, muted: { ...sounds.muted, [name]: !sounds.muted[name] } })
                    }
                  >
                    {sounds.muted[name] ? t.soundOffShort : t.soundOnShort}
                  </button>
                  <button className="lang-btn" onClick={() => playSound(name, sounds)}>
                    {t.test}
                  </button>
                </div>
              </div>
            ))}
          </>
        )}

        <div className="modal-actions">
          <button className="act primary" onClick={onClose}>
            {t.close}
          </button>
        </div>
      </div>
    </div>
  );
}
