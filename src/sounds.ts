/**
 * Звуковой движок Кладовки.
 *
 * Никаких внешних .wav/.mp3: короткие звуки синтезируются Web Audio API
 * (осцилляторы + огибающая), поэтому не добавляют веса бандлу и не требуют
 * разрешения на доступ к файлам. Все звуки очень короткие (60–180 мс).
 */

export type SoundName =
  | "select"
  | "copy"
  | "move"
  | "drop"
  | "error"
  | "rename"
  | "new";

export type SoundSettings = {
  enabled: boolean;
  volume: number; // 0..1
  muted: Record<SoundName, boolean>;
};

const STORAGE_KEY = "kladovka-sounds";

export const defaultSoundSettings: SoundSettings = {
  enabled: true,
  volume: 0.5,
  muted: {
    select: false,
    copy: false,
    move: false,
    drop: false,
    error: false,
    rename: false,
    new: false,
  },
};

export function loadSoundSettings(): SoundSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...defaultSoundSettings };
    const parsed = JSON.parse(raw) as Partial<SoundSettings>;
    return {
      enabled: parsed.enabled ?? defaultSoundSettings.enabled,
      volume: typeof parsed.volume === "number" ? Math.min(1, Math.max(0, parsed.volume)) : defaultSoundSettings.volume,
      muted: { ...defaultSoundSettings.muted, ...(parsed.muted ?? {}) },
    };
  } catch {
    return { ...defaultSoundSettings };
  }
}

export function saveSoundSettings(s: SoundSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* приватный режим — молча игнорируем */
  }
}

type Tone = {
  freq: number;
  dur: number;
  at?: number;
  type?: OscillatorType;
  gain?: number;
  slideTo?: number;
};

/** Характеристики каждого звука. */
const RECIPES: Record<SoundName, Tone[]> = {
  // мягкий одиночный «тик» при навигации/выборе
  select: [{ freq: 1180, dur: 0.045, type: "triangle", gain: 0.35 }],
  // две восходящие ноты — «скопировал»
  copy: [
    { freq: 620, dur: 0.07, type: "sine", gain: 0.5 },
    { freq: 930, dur: 0.09, at: 0.06, type: "sine", gain: 0.5 },
  ],
  // короткий «свист» вниз-вверх — «перенёс»
  move: [
    { freq: 840, dur: 0.09, type: "sine", gain: 0.5, slideTo: 1180 },
  ],
  // мягкий «плюх» при отпускании файлов
  drop: [
    { freq: 480, dur: 0.09, type: "sine", gain: 0.5, slideTo: 320 },
    { freq: 640, dur: 0.06, at: 0.07, type: "triangle", gain: 0.3 },
  ],
  // диссонанс — ошибка
  error: [
    { freq: 320, dur: 0.12, type: "square", gain: 0.22 },
    { freq: 270, dur: 0.14, at: 0.04, type: "square", gain: 0.22 },
  ],
  // короткая «перезапись» — переименование
  rename: [
    { freq: 760, dur: 0.05, type: "triangle", gain: 0.4 },
    { freq: 760, dur: 0.05, at: 0.07, type: "triangle", gain: 0.4 },
  ],
  // восходящий арпеджио — создан новый объект
  new: [
    { freq: 660, dur: 0.06, type: "sine", gain: 0.42 },
    { freq: 880, dur: 0.06, at: 0.055, type: "sine", gain: 0.42 },
    { freq: 1100, dur: 0.09, at: 0.11, type: "sine", gain: 0.42 },
  ],
};

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    // Браузеры приостанавливают контекст до первого жеста пользователя
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Проиграть звук по имени. Безопасно вызывать откуда угодно. */
export function playSound(name: SoundName, settings: SoundSettings) {
  if (!settings.enabled || settings.muted[name]) return;
  const audio = getCtx();
  if (!audio) return;
  try {
    const now = audio.currentTime;
    for (const tone of RECIPES[name]) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      const start = now + (tone.at ?? 0);
      const end = start + tone.dur;
      osc.type = tone.type ?? "sine";
      osc.frequency.setValueAtTime(tone.freq, start);
      if (tone.slideTo) osc.frequency.exponentialRampToValueAtTime(tone.slideTo, end);
      const peak = tone.gain ?? 0.45;
      const vol = settings.volume * peak;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain).connect(audio.destination);
      osc.start(start);
      osc.stop(end + 0.02);
    }
  } catch {
    /* звук — не критичная функция */
  }
}
