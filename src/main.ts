import { hasWebGL2, isTouchOnly } from './device';
import { GameAudio } from './game/audio';
import { Game } from './game/Game';
import { loadSettings, saveSettings } from './settings';
import { strings } from './strings';
import { UI } from './ui/ui';

async function main(): Promise<void> {
  const ui = new UI();

  if (isTouchOnly()) {
    ui.showMessage(strings.desktopOnlyTitle, strings.desktopOnlyBody);
    return;
  }
  if (!hasWebGL2()) {
    ui.showMessage(strings.title, strings.webglMissing);
    return;
  }

  const settings = loadSettings();
  const audio = new GameAudio();
  audio.setVolume(settings.volume);

  const loading = ui.showLoading();
  let game: Game;
  try {
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    game = await Game.create(canvas, audio, settings, loading.setProgress);
  } catch (err) {
    console.error(err);
    ui.showMessage(strings.title, strings.loadingFailed);
    return;
  }
  await loading.finish();

  game.onHud = (hud) => ui.updateHud(hud);
  // Handy for poking at the game from the browser console during development.
  if (import.meta.env.DEV) Object.assign(window, { kio: game });

  const startPlaying = async (): Promise<boolean> => {
    audio.unlock();
    if (!(await game.input.lock())) return false;
    game.play();
    ui.hideScreens();
    return true;
  };

  const showTitle = () => ui.showTitle(() => void startPlaying());

  game.onPauseRequest = () => {
    game.pause();
    const pause = ui.showPause(settings, {
      onResume: async () => {
        if (!(await startPlaying())) pause.setHint(strings.clickToResume);
      },
      onQuit: () => {
        game.toTitle();
        showTitle();
      },
      onSettings: (s) => {
        audio.setVolume(s.volume);
        saveSettings(s);
      },
    });
  };

  showTitle();
}

void main();
