export type MouseButton = 'left' | 'right';

export interface ButtonEvent {
  button: MouseButton;
  down: boolean;
}

// Keyboard and mouse state for one frame. Mouse look uses pointer lock.
export class Input {
  readonly held = new Set<string>();
  private justPressed = new Set<string>();
  readonly buttons = { left: false, right: false };
  buttonEvents: ButtonEvent[] = [];
  mouseDx = 0;
  mouseDy = 0;
  enabled = false;

  constructor(private target: HTMLElement) {
    addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (!e.repeat) this.justPressed.add(e.code);
      this.held.add(e.code);
    });
    addEventListener('keyup', (e) => this.held.delete(e.code));
    addEventListener('blur', () => this.releaseAll());

    target.addEventListener('contextmenu', (e) => e.preventDefault());
    target.addEventListener('mousedown', (e) => this.onButton(e, true));
    addEventListener('mouseup', (e) => this.onButton(e, false));
    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDx += e.movementX;
      this.mouseDy += e.movementY;
    });
  }

  get locked(): boolean {
    return document.pointerLockElement === this.target;
  }

  async lock(): Promise<boolean> {
    try {
      await this.target.requestPointerLock();
      return true;
    } catch {
      // Browsers refuse a re-lock for about a second after Esc.
      return false;
    }
  }

  pressed(...codes: string[]): boolean {
    return codes.some((c) => this.justPressed.has(c));
  }

  down(...codes: string[]): boolean {
    return codes.some((c) => this.held.has(c));
  }

  // Call at the end of each rendered frame.
  endFrame(): void {
    this.justPressed.clear();
    this.buttonEvents = [];
    this.mouseDx = 0;
    this.mouseDy = 0;
  }

  releaseAll(): void {
    this.held.clear();
    this.buttons.left = false;
    this.buttons.right = false;
  }

  private onButton(e: MouseEvent, down: boolean): void {
    const button: MouseButton | null = e.button === 0 ? 'left' : e.button === 2 ? 'right' : null;
    if (!button) return;
    if (this.buttons[button] === down) return;
    this.buttons[button] = down;
    if (this.enabled && this.locked) this.buttonEvents.push({ button, down });
  }
}
