import { credits } from '../credits';
import type { Settings } from '../settings';
import { strings } from '../strings';

const LOADING_MIN_MS = 3000;
const LOADING_LINE_MS = 2000;

type Attrs = Record<string, string>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

function button(label: string, onClick: () => void, cls = 'btn'): HTMLButtonElement {
  const b = el('button', { class: cls, type: 'button' }, label);
  b.addEventListener('click', onClick);
  return b;
}

// Owns every overlay screen. Only one screen shows at a time; the HUD sits underneath.
export class UI {
  private root = document.getElementById('ui')!;
  private screen: HTMLElement | null = null;
  private hud = el('div', { class: 'hud hidden' });
  private crosshair = el('div', { class: 'crosshair' });
  private spike = el('div', { class: 'spike hidden' }, strings.spike);
  private charge = el('div', { class: 'charge hidden' }, el('div', { class: 'charge-fill' }));

  constructor() {
    this.hud.append(this.crosshair, this.spike, this.charge);
    this.root.append(this.hud);
  }

  private show(screen: HTMLElement | null): void {
    this.screen?.remove();
    this.screen = screen;
    if (screen) this.root.append(screen);
  }

  showMessage(title: string, body: string): void {
    this.show(el('div', { class: 'screen solid' }, el('div', { class: 'panel' }, el('h1', {}, title), el('p', {}, body))));
  }

  // Shows rotating joke lines; `finish()` resolves once loading is done
  // and the screen has been up for at least LOADING_MIN_MS.
  showLoading(): { setProgress(fraction: number): void; finish(): Promise<void> } {
    const started = performance.now();
    const lines = shuffled(strings.loadingLines);
    let index = 0;
    const line = el('p', { class: 'loading-line' }, lines[0]);
    const fill = el('div', { class: 'progress-fill' });
    this.show(
      el('div', { class: 'screen solid' },
        el('div', { class: 'panel' },
          el('h1', { class: 'logo' }, strings.title),
          line,
          el('div', { class: 'progress' }, fill),
        ),
      ),
    );
    const timer = setInterval(() => {
      index = (index + 1) % lines.length;
      line.textContent = lines[index];
    }, LOADING_LINE_MS);

    return {
      setProgress: (f) => {
        fill.style.width = `${Math.round(f * 100)}%`;
      },
      finish: async () => {
        fill.style.width = '100%';
        const wait = LOADING_MIN_MS - (performance.now() - started);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        clearInterval(timer);
      },
    };
  }

  showTitle(onPlay: () => void): void {
    this.setHudVisible(false);
    this.show(
      el('div', { class: 'screen' },
        el('div', { class: 'panel' },
          el('h1', { class: 'logo' }, strings.title),
          el('p', { class: 'tagline' }, strings.tagline),
          el('div', { class: 'menu' },
            button(strings.play, onPlay, 'btn primary'),
            button(strings.controls, () => this.showControls(() => this.showTitle(onPlay))),
            button(strings.credits, () => this.showCredits(() => this.showTitle(onPlay))),
          ),
        ),
      ),
    );
  }

  showControls(onBack: () => void): void {
    const rows = strings.controlsList.map(([key, action]) => el('tr', {}, el('td', { class: 'key' }, key), el('td', {}, action)));
    this.show(
      el('div', { class: 'screen' },
        el('div', { class: 'panel' },
          el('h2', {}, strings.controls),
          el('table', { class: 'controls' }, ...rows),
          button(strings.back, onBack),
        ),
      ),
    );
  }

  showCredits(onBack: () => void): void {
    const items = credits.map((c) => {
      const name = c.url ? el('a', { href: c.url, target: '_blank', rel: 'noopener' }, c.what) : c.what;
      return el('li', {}, name, ` by ${c.author} (${c.license})`);
    });
    this.show(
      el('div', { class: 'screen' },
        el('div', { class: 'panel' },
          el('h2', {}, strings.credits),
          el('p', {}, strings.creditsHeading),
          el('ul', { class: 'credits' }, ...items),
          button(strings.back, onBack),
        ),
      ),
    );
  }

  showPause(
    settings: Settings,
    handlers: { onResume(): void; onQuit(): void; onSettings(s: Settings): void },
  ): { setHint(text: string): void } {
    this.setHudVisible(false);
    const hint = el('p', { class: 'hint' });

    const slider = (label: string, min: number, max: number, step: number, value: number, set: (v: number) => void) => {
      const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
      input.value = String(value);
      input.addEventListener('input', () => {
        set(Number(input.value));
        handlers.onSettings(settings);
      });
      return el('label', { class: 'setting' }, el('span', {}, label), input);
    };
    const invert = el('input', { type: 'checkbox' });
    invert.checked = settings.invertY;
    invert.addEventListener('change', () => {
      settings.invertY = invert.checked;
      handlers.onSettings(settings);
    });

    this.show(
      el('div', { class: 'screen' },
        el('div', { class: 'panel' },
          el('h2', {}, strings.paused),
          slider(strings.sensitivity, 0.2, 3, 0.05, settings.sensitivity, (v) => (settings.sensitivity = v)),
          el('label', { class: 'setting' }, el('span', {}, strings.invertY), invert),
          slider(strings.volume, 0, 1, 0.01, settings.volume, (v) => (settings.volume = v)),
          hint,
          el('div', { class: 'menu' },
            button(strings.resume, handlers.onResume, 'btn primary'),
            button(strings.quitToTitle, handlers.onQuit),
          ),
        ),
      ),
    );
    return { setHint: (text) => (hint.textContent = text) };
  }

  hideScreens(): void {
    this.show(null);
    this.setHudVisible(true);
  }

  updateHud(state: { spikeWindow: boolean; charge: number | null }): void {
    this.spike.classList.toggle('hidden', !state.spikeWindow);
    this.charge.classList.toggle('hidden', state.charge === null);
    if (state.charge !== null) {
      (this.charge.firstElementChild as HTMLElement).style.width = `${Math.round(state.charge * 100)}%`;
    }
  }

  private setHudVisible(visible: boolean): void {
    this.hud.classList.toggle('hidden', !visible);
  }
}

function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
