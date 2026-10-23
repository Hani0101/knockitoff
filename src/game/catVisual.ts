import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { catModel } from '../config';

// Animation names the cat model must provide (see docs/blender-guide.md).
export const CAT_ANIMS = [
  'idle', 'walk', 'run', 'jump', 'land', 'climb',
  'swipe_L', 'swipe_R', 'grab', 'hold', 'throw', 'trick',
] as const;
export type CatAnim = (typeof CAT_ANIMS)[number];

const ONE_SHOT: ReadonlySet<CatAnim> = new Set(['jump', 'land', 'climb', 'swipe_L', 'swipe_R', 'grab', 'throw', 'trick']);

export interface CatPose {
  speed: number;
  // World point the head should turn toward, or null to look ahead.
  lookAt: THREE.Vector3 | null;
}

// What the cat controller drives. Origin at the cat's feet, facing -Z.
export interface CatVisual {
  readonly object: THREE.Object3D;
  play(anim: CatAnim): void;
  update(dt: number, pose: CatPose): void;
}

const HEAD_MAX_YAW = 0.8;
const HEAD_MAX_PITCH = 0.4;
const HEAD_TURN_SPEED = 2.5;

// Head yaw/pitch toward `target`, in the cat's local frame, clamped.
function headAngles(root: THREE.Object3D, headWorld: THREE.Vector3, target: THREE.Vector3 | null): [number, number] {
  if (!target) return [0, 0];
  const local = root.worldToLocal(target.clone()).sub(root.worldToLocal(headWorld.clone()));
  // Too close to aim at reliably, or behind her: look straight ahead.
  if (Math.hypot(local.x, local.z) < 0.15) return [0, 0];
  const yaw = Math.atan2(-local.x, -local.z);
  const pitch = Math.atan2(local.y, Math.hypot(local.x, local.z));
  if (Math.abs(yaw) > HEAD_MAX_YAW * 1.6) return [0, 0];
  return [
    THREE.MathUtils.clamp(yaw, -HEAD_MAX_YAW, HEAD_MAX_YAW),
    THREE.MathUtils.clamp(pitch, -HEAD_MAX_PITCH, HEAD_MAX_PITCH),
  ];
}

// ---------------------------------------------------------------------------
// Grey-box cat posed in code. Stands in until the rigged model exists.

export class PlaceholderCat implements CatVisual {
  readonly object = new THREE.Group();
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private pawL = new THREE.Group();
  private pawR = new THREE.Group();
  private hindLegs: THREE.Object3D[] = [];
  private tail: THREE.Group[] = [];
  private anim: CatAnim = 'idle';
  private animTime = 0;
  private time = 0;
  private pitch = 0;
  private headYaw = 0;
  private headPitch = 0;

  constructor() {
    const fur = new THREE.MeshStandardMaterial({ color: 0xe8a35c, roughness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x3a2a20, roughness: 0.5 });
    const shadow = (m: THREE.Mesh) => {
      m.castShadow = true;
      return m;
    };

    // Torso pivots at the hips so "sitting up" rotates around the back legs.
    this.torso.position.set(0, 0.13, 0.15);
    this.object.add(this.torso);
    const body = shadow(new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.24, 6, 12), fur));
    body.rotation.x = Math.PI / 2;
    body.position.set(0, 0.02, -0.15);
    this.torso.add(body);

    this.head.position.set(0, 0.1, -0.36);
    this.torso.add(this.head);
    this.head.add(shadow(new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), fur)));
    for (const side of [-1, 1]) {
      const ear = shadow(new THREE.Mesh(new THREE.ConeGeometry(0.028, 0.06, 4), fur));
      ear.position.set(side * 0.042, 0.075, 0.005);
      ear.rotation.z = -side * 0.25;
      this.head.add(ear);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), dark);
      eye.position.set(side * 0.03, 0.015, -0.066);
      this.head.add(eye);
    }
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.01, 6, 4), dark);
    nose.position.set(0, -0.01, -0.075);
    this.head.add(nose);

    // Front legs double as swiping paws; they hang from the shoulders.
    const leg = () => {
      const m = shadow(new THREE.Mesh(new THREE.CapsuleGeometry(0.022, 0.1, 4, 8), fur));
      m.position.y = -0.07;
      return m;
    };
    this.pawL.position.set(-0.05, -0.02, -0.28);
    this.pawR.position.set(0.05, -0.02, -0.28);
    this.pawL.add(leg());
    this.pawR.add(leg());
    this.torso.add(this.pawL, this.pawR);
    for (const side of [-1, 1]) {
      const hind = new THREE.Group();
      hind.position.set(side * 0.05, 0.11, 0.13);
      hind.add(leg());
      this.object.add(hind);
      this.hindLegs.push(hind);
    }

    let parent: THREE.Object3D = this.torso;
    for (let i = 0; i < 4; i++) {
      const seg = new THREE.Group();
      seg.position.set(0, i === 0 ? 0.03 : 0, 0.07);
      // Negative pitch curls each segment upward.
      seg.rotation.x = i === 0 ? -0.6 : -0.3;
      const m = shadow(new THREE.Mesh(new THREE.CapsuleGeometry(0.016, 0.05, 4, 8), fur));
      m.rotation.x = Math.PI / 2;
      m.position.z = 0.035;
      seg.add(m);
      parent.add(seg);
      this.tail.push(seg);
      parent = seg;
    }
  }

  play(anim: CatAnim): void {
    if (anim === this.anim && !ONE_SHOT.has(anim)) return;
    this.anim = anim;
    this.animTime = 0;
  }

  update(dt: number, pose: CatPose): void {
    this.time += dt;
    this.animTime += dt;
    const t = this.animTime;
    const sitting = this.anim === 'grab' || this.anim === 'hold' || this.anim === 'throw' || this.anim === 'trick';

    let targetPitch = 0;
    if (sitting) targetPitch = -1.0;
    else if (this.anim === 'jump') targetPitch = -0.35;
    else if (this.anim === 'climb') targetPitch = t < 0.3 ? -0.9 : 0;
    this.pitch += (targetPitch - this.pitch) * Math.min(1, 14 * dt);
    this.torso.rotation.x = -this.pitch;

    // Locomotion: bob and leg swing scale with speed.
    const stride = this.anim === 'run' ? 16 : 10;
    const moving = this.anim === 'walk' || this.anim === 'run';
    const swing = moving ? Math.sin(this.time * stride) * Math.min(0.6, pose.speed * 0.25) : 0;
    this.torso.position.y = 0.13 + (moving ? Math.abs(Math.sin(this.time * stride)) * 0.012 : Math.sin(this.time * 2) * 0.003);
    this.hindLegs[0].rotation.x = -swing;
    this.hindLegs[1].rotation.x = swing;

    // Front paws: swipes, holding pose, or walking.
    let left = swing;
    let right = -swing;
    if (this.anim === 'swipe_L') left = pawStrike(t);
    if (this.anim === 'swipe_R') right = pawStrike(t);
    if (sitting) {
      const raise = this.anim === 'throw' ? 2.2 - Math.min(1, t * 6) * 1.2
        : this.anim === 'trick' ? (t < 0.15 ? 2.6 : 1.4)
        : 1.4;
      left = right = raise;
    }
    this.pawL.rotation.x += (left - this.pawL.rotation.x) * Math.min(1, 30 * dt);
    this.pawR.rotation.x += (right - this.pawR.rotation.x) * Math.min(1, 30 * dt);

    // Code-driven head look-at.
    const [yaw, pitch] = headAngles(this.object, this.head.getWorldPosition(new THREE.Vector3()), pose.lookAt);
    this.headYaw += (yaw - this.headYaw) * Math.min(1, 6 * dt);
    this.headPitch += (pitch - this.headPitch) * Math.min(1, 6 * dt);
    this.head.rotation.set(this.headPitch + this.pitch, this.headYaw, 0, 'YXZ');

    // Code-driven tail sway, livelier when moving.
    const freq = 2 + pose.speed * 2;
    const amp = 0.15 + Math.min(pose.speed, 3) * 0.1;
    this.tail.forEach((seg, i) => {
      seg.rotation.y = Math.sin(this.time * freq - i * 0.7) * amp;
    });

    if (ONE_SHOT.has(this.anim) && t > 0.6 && this.anim !== 'grab' && this.anim !== 'trick') {
      this.anim = 'idle';
    }
  }
}

// Paw rotation over a swipe: wind back, strike forward and up, return.
function pawStrike(t: number): number {
  if (t < 0.08) return -0.5;
  if (t < 0.2) return 1.8;
  return 0;
}

// ---------------------------------------------------------------------------
// Rigged GLB cat. Plays clips by name and layers head look-at and tail sway
// on top of the animation.

export class GltfCat implements CatVisual {
  readonly object = new THREE.Group();
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private currentName: CatAnim | null = null;
  // Neck bones then the head, each taking a share of the look rotation.
  private lookChain: { bone: THREE.Object3D; share: number }[] = [];
  private tail: THREE.Object3D[];
  private headYaw = 0;
  private headPitch = 0;
  private tailPhase = 0;
  private tailAmp = 0;
  // The animated (pre-adjustment) rotation of every bone the code adjusts.
  private animated = new Map<THREE.Object3D, THREE.Quaternion>();
  private warned = new Set<string>();

  constructor(gltf: GLTF) {
    const model = gltf.scene;
    model.scale.setScalar(catModel.scale);
    model.rotation.y = catModel.yawOffset;
    model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    this.object.add(model);

    this.mixer = new THREE.AnimationMixer(model);
    for (const clip of gltf.animations) this.actions.set(clip.name, this.mixer.clipAction(clip));
    const missing = CAT_ANIMS.filter((n) => !this.actions.has(n));
    if (missing.length) console.warn(`Cat model is missing animations: ${missing.join(', ')}`);

    // GLTFLoader strips characters like "." from node names ("DEF-tail.001"
    // becomes "DEF-tail001"), so look bones up by their sanitized Blender names.
    const bone = (name: string) => model.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name));
    const head = bone(catModel.headBone);
    const neck = catModel.neckBones.map(bone).filter((b): b is THREE.Object3D => !!b);
    if (head) {
      // Half the turn in the neck, half in the head.
      neck.forEach((b) => this.lookChain.push({ bone: b, share: 0.5 / neck.length }));
      this.lookChain.push({ bone: head, share: neck.length ? 0.5 : 1 });
    }
    this.tail = catModel.tailBones.map(bone).filter((b): b is THREE.Object3D => !!b);
    if (!head) console.warn(`Head bone "${catModel.headBone}" not found; set catModel.headBone in config.ts`);
    if (neck.length !== catModel.neckBones.length) {
      console.warn(`Only ${neck.length} of ${catModel.neckBones.length} neck bones found; check catModel.neckBones in config.ts`);
    }
    if (this.tail.length !== catModel.tailBones.length) {
      console.warn(`Only ${this.tail.length} of ${catModel.tailBones.length} tail bones found; check catModel.tailBones in config.ts`);
    }
    for (const b of [...this.lookChain.map((l) => l.bone), ...this.tail]) this.animated.set(b, b.quaternion.clone());
    this.play('idle');
  }

  play(anim: CatAnim): void {
    if (anim === this.currentName && !ONE_SHOT.has(anim)) return;
    const action = this.actions.get(anim) ?? this.actions.get('idle');
    if (!action) return;
    if (!this.actions.has(anim) && !this.warned.has(anim)) {
      this.warned.add(anim);
      console.warn(`Missing cat animation "${anim}", using idle`);
    }
    const oneShot = ONE_SHOT.has(anim);
    action.reset();
    action.setLoop(oneShot ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = oneShot;
    if (this.current && this.current !== action) action.crossFadeFrom(this.current, 0.15, false);
    action.play();
    this.current = action;
    this.currentName = anim;
  }

  update(dt: number, pose: CatPose): void {
    // The mixer only writes a bone when the clip's value changes, so on frames
    // where a clip holds the head or tail still, last frame's look-at and sway
    // would stay on the bone and the next adjustment would stack on top (the
    // head ends up spinning). Put the animated rotation back first.
    for (const [bone, q] of this.animated) bone.quaternion.copy(q);
    this.mixer.update(dt);
    for (const [bone, q] of this.animated) q.copy(bone.quaternion);
    this.object.updateMatrixWorld(true);
    const catQuat = this.object.getWorldQuaternion(new THREE.Quaternion());
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(catQuat);

    // Head look-at, eased and speed-limited so it never whips around.
    const head = this.lookChain.at(-1)?.bone;
    if (head) {
      const [yaw, pitch] = headAngles(this.object, head.getWorldPosition(new THREE.Vector3()), pose.lookAt);
      this.headYaw = easeAngle(this.headYaw, yaw, dt);
      this.headPitch = easeAngle(this.headPitch, pitch, dt);
      for (const { bone, share } of this.lookChain) {
        const delta = new THREE.Quaternion()
          .setFromAxisAngle(up, this.headYaw * share)
          .multiply(new THREE.Quaternion().setFromAxisAngle(right, this.headPitch * share));
        rotateBoneInWorld(bone, delta);
      }
    }

    // Tail sway: a slow side-to-side wave running down the tail, calmer when
    // moving. "Side to side" is relative to where the tail points, so a raised
    // tail swings left and right rather than twisting around itself.
    if (this.tail.length >= 2) {
      const speed = Math.min(pose.speed, 4);
      this.tailPhase += (1.8 + speed * 1.2) * dt;
      this.tailAmp += (TAIL_SWAY / (1 + speed) - this.tailAmp) * Math.min(1, 3 * dt);
      const base = this.tail[0].getWorldPosition(new THREE.Vector3());
      const dir = this.tail[1].getWorldPosition(new THREE.Vector3()).sub(base);
      const axis = dir.cross(right);
      if (axis.lengthSq() > 1e-8) {
        axis.normalize();
        this.tail.forEach((bone, i) => {
          const angle = Math.sin(this.tailPhase - i * 0.6) * this.tailAmp;
          rotateBoneInWorld(bone, new THREE.Quaternion().setFromAxisAngle(axis, angle));
        });
      }
    }
  }
}

// Peak sway per tail bone (radians) when standing still.
const TAIL_SWAY = 0.12;

// Moves an angle toward a target smoothly, at most HEAD_TURN_SPEED rad/s.
function easeAngle(current: number, target: number, dt: number): number {
  const step = (target - current) * Math.min(1, 5 * dt);
  const max = HEAD_TURN_SPEED * dt;
  return current + THREE.MathUtils.clamp(step, -max, max);
}

// Applies a world-space rotation on top of a bone's animated pose, whatever
// the bone's own axis orientation is.
function rotateBoneInWorld(bone: THREE.Object3D, delta: THREE.Quaternion): void {
  if (!bone.parent) return;
  const parentWorld = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  const boneWorld = bone.getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.copy(parentWorld.invert().multiply(delta.multiply(boneWorld)));
  bone.updateMatrixWorld(true);
}
