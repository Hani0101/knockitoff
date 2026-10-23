// Player settings, remembered in this browser only.
export interface Settings {
  sensitivity: number;
  invertY: boolean;
  volume: number;
}

const KEY = 'knock-it-off:settings';
const defaults: Settings = { sensitivity: 1, invertY: false, volume: 0.8 };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch {
    // Storage blocked or corrupt: fall back to defaults.
  }
  return { ...defaults };
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage blocked: settings just won't persist.
  }
}
