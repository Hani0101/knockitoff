import * as THREE from 'three';
import { assets, tuning } from '../config';
import type { Settings } from '../settings';
import { makeGltfLoader } from './assets';
import type { GameAudio } from './audio';
import { CameraRig } from './CameraRig';
import { Cat, type CatHud } from './Cat';
import { GltfCat, PlaceholderCat, type CatVisual } from './catVisual';
import { Input } from './input';
import { initPhysics, RAPIER } from './physics';
import { PropSystem } from './props';
import { buildGreyboxRoom, parseRoom } from './room';

const STEP = 1 / 60;
const MAX_STEPS = 5;

export type Mode = 'title' | 'playing' | 'paused';

export class Game {
  mode: Mode = 'title';
  // Called when the player leaves pointer lock mid-game (e.g. presses Esc).
  onPauseRequest: () => void = () => {};
  onHud: (hud: CatHud) => void = () => {};

  private sun = new THREE.DirectionalLight(0xfff1dd, 1.8);
  private eventQueue = new RAPIER.EventQueue(true);
  private accumulator = 0;
  private last = performance.now();

  private constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private world: InstanceType<typeof RAPIER.World>,
    private rig: CameraRig,
    private cat: Cat,
    private props: PropSystem,
    private audio: GameAudio,
    private settings: Settings,
    readonly input: Input,
  ) {
    this.setupLights();
    addEventListener('resize', () => this.resize());
    document.addEventListener('pointerlockchange', () => {
      if (!this.input.locked && this.mode === 'playing') this.onPauseRequest();
    });
    this.resize();
    renderer.setAnimationLoop(() => this.frame());
  }

  static async create(
    canvas: HTMLCanvasElement,
    audio: GameAudio,
    settings: Settings,
    onProgress: (fraction: number) => void,
  ): Promise<Game> {
    await initPhysics();
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf6e9d6);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 50);
    const world = new RAPIER.World({ x: 0, y: -tuning.gravity, z: 0 });
    world.timestep = STEP;

    const manager = new THREE.LoadingManager();
    manager.onProgress = (_url, loaded, total) => onProgress(total ? loaded / total : 1);
    const loader = makeGltfLoader(renderer, manager);
    const [roomGltf, catGltf] = await Promise.all([
      assets.room ? loader.loadAsync(assets.room) : null,
      assets.cat ? loader.loadAsync(assets.cat) : null,
    ]);
    onProgress(1);

    const roomRoot = roomGltf ? roomGltf.scene : buildGreyboxRoom();
    scene.add(roomRoot);
    const room = parseRoom(roomRoot, world);

    const visual: CatVisual = catGltf ? new GltfCat(catGltf) : new PlaceholderCat();
    scene.add(visual.object);

    const props = new PropSystem(scene, world, room.props, audio);
    const cat = new Cat(world, visual, room.spawn, props, audio);
    const rig = new CameraRig(camera, world);
    const input = new Input(canvas);

    return new Game(renderer, scene, camera, world, rig, cat, props, audio, settings, input);
  }

  play(): void {
    this.mode = 'playing';
    this.input.enabled = true;
    this.input.releaseAll();
  }

  pause(): void {
    this.mode = 'paused';
    this.input.enabled = false;
    this.input.releaseAll();
  }

  toTitle(): void {
    this.pause();
    this.mode = 'title';
    this.reset();
    this.cat.respawn();
  }

  reset(): void {
    this.cat.releaseAll();
    this.props.reset();
  }

  private frame(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;

    if (this.mode === 'playing') this.simulate(dt);
    else if (this.mode === 'title') this.rig.yaw += dt * 0.15;

    this.cat.updateVisual(this.mode === 'playing' ? dt : 0);
    this.rig.update(this.cat.feet, dt);
    this.followShadow();
    this.renderer.render(this.scene, this.camera);
    this.input.endFrame();
  }

  private simulate(dt: number): void {
    const input = this.input;
    this.rig.look(input.mouseDx, input.mouseDy, this.settings.sensitivity, this.settings.invertY);
    if (input.pressed('KeyR')) this.reset();
    if (input.pressed('KeyM')) this.audio.meow();
    this.cat.handleInput(input, this.rig);

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= STEP && steps < MAX_STEPS) {
      this.cat.step(STEP);
      this.world.step(this.eventQueue);
      this.eventQueue.drainCollisionEvents((h1, h2, started) => {
        if (started) this.props.onCollision(h1, h2, this.cat.colliderHandle);
      });
      this.props.sync();
      this.accumulator -= STEP;
      steps++;
    }
    if (steps === MAX_STEPS) this.accumulator = 0;
    this.onHud(this.cat.hud);
  }

  private setupLights(): void {
    this.scene.add(new THREE.HemisphereLight(0xfff6e8, 0x8a6f5a, 1.3));
    const s = this.sun;
    s.castShadow = true;
    s.shadow.mapSize.set(2048, 2048);
    s.shadow.bias = -0.0005;
    s.shadow.normalBias = 0.02;
    const cam = s.shadow.camera;
    cam.left = cam.bottom = -3;
    cam.right = cam.top = 3;
    cam.near = 0.5;
    cam.far = 12;
    this.scene.add(s, s.target);
  }

  // The one shadow-casting light follows the cat so its shadow stays crisp.
  private followShadow(): void {
    const feet = this.cat.feet;
    this.sun.target.position.copy(feet);
    this.sun.position.copy(feet).add(new THREE.Vector3(2, 6, 3));
  }

  private resize(): void {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
