import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { catModel } from '../config';

// Animation names the cat model must provide (see docs/blender-guide.md).
export const CAT_ANIMS = [
  'idle', 'walk', 'run', 'jump', 'land', 'climb',
  'swipe_L', 'swipe_R', 'grab', 'hold', 'throw', 'trick', 'pounce', 'descend',
] as const;
export type CatAnim = (typeof CAT_ANIMS)[number];

const ONE_SHOT: ReadonlySet<CatAnim> = new Set(['jump', 'land', 'climb', 'swipe_L', 'swipe_R', 'grab', 'throw', 'trick', 'descend']);

export interface CatPose {
  speed: number;
  // World point the head should turn toward, or null to look ahead.
  lookAt: THREE.Vector3 | null;
  // How far she is wound up for a throw, 0 to 1 (only while holding).
  windup: number;
  grounded: boolean;
  // How far into the crouch before a jump she is, 0 to 1.
  crouch: number;
  // Lets the tail feel the room it brushes against.
  probe: SurfaceProbe | null;
}

// Casts a ray into the room (furniture, walls, floor and props, but not the
// cat or what she holds). Returns how far along `dir` (a unit vector) it hit
// something, and that surface's normal.
export type SurfaceProbe = (
  from: THREE.Vector3, dir: THREE.Vector3, maxDist: number,
) => { dist: number; normal: THREE.Vector3 } | null;

// What the cat controller drives. Origin at the cat's feet, facing -Z.
export interface CatVisual {
  readonly object: THREE.Object3D;
  play(anim: CatAnim): void;
  update(dt: number, pose: CatPose): void;
}

const HEAD_MAX_YAW = 0.8;
const HEAD_MAX_PITCH = 0.4;
// She can look further down than up, to peer over edges and at her paws.
const HEAD_MAX_PITCH_DOWN = 0.9;
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
    THREE.MathUtils.clamp(pitch, -HEAD_MAX_PITCH_DOWN, HEAD_MAX_PITCH),
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
    else if (this.anim === 'pounce') targetPitch = -0.15;
    else if (this.anim === 'descend') targetPitch = 0.3;
    this.pitch += (targetPitch - this.pitch) * Math.min(1, 14 * dt);
    this.torso.rotation.x = -this.pitch;
    const crouchDrop = this.anim === 'pounce' ? 0.04 : 0;

    // Locomotion: bob and leg swing scale with speed.
    const stride = this.anim === 'run' ? 16 : 10;
    const moving = this.anim === 'walk' || this.anim === 'run';
    const swing = moving ? Math.sin(this.time * stride) * Math.min(0.6, pose.speed * 0.25) : 0;
    this.torso.position.y = 0.13 - crouchDrop + (moving ? Math.abs(Math.sin(this.time * stride)) * 0.012 : Math.sin(this.time * 2) * 0.003);
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
// Rigged GLB cat. Plays clips by name and layers head look-at, tail sway and
// tail follow-through on top of the animation, plus a throw wind-up that
// grows with the charge and squash and stretch on jumps and landings.

// Frame rate of the Blender clips (keys are in 24 fps frames), the throw
// clip's "wind" pose (paws drawn back), which a charging throw leans into,
// and the jump clip's crouch.
const CLIP_FPS = 24;
const WIND_FRAME = 2;
const JUMP_CROUCH_FRAME = 3;
const CROSSFADE = 0.15;

export class GltfCat implements CatVisual {
  readonly object = new THREE.Group();
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private currentName: CatAnim | null = null;
  // Additive "wind" pose, weighted by the throw charge.
  private windAction: THREE.AnimationAction | null = null;
  private wind = 0;
  private tailSprings: { side: Spring; lift: Spring }[] = [];
  private lastPos: THREE.Vector3 | null = null;
  private lastYaw = 0;
  private lastYawRate = 0;
  private vel = new THREE.Vector3();
  private squash = new SquashStretch();
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
    this.squash.group.add(model);
    this.object.add(this.squash.group);

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
    this.tailSprings = this.tail.map(() => ({ side: new Spring(), lift: new Spring() }));

    const throwClip = gltf.animations.find((c) => c.name === 'throw');
    if (throwClip) {
      const wind = poseAt(throwClip, 'throw_wind', WIND_FRAME / CLIP_FPS);
      THREE.AnimationUtils.makeClipAdditive(wind, 0, throwClip, CLIP_FPS);
      this.windAction = this.mixer.clipAction(wind);
      this.windAction.setEffectiveWeight(0).play();
    }
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
    action.timeScale = 1;
    action.setLoop(oneShot ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = oneShot;
    // A throw released after winding up starts from the wind pose instead of
    // winding up a second time. The additive wind fades out over the crossfade.
    if (anim === 'throw') action.time = (WIND_FRAME / CLIP_FPS) * this.wind;
    // Out of a pounce she's already crouched, so the leap starts from the
    // jump clip's crouch.
    if (anim === 'jump' && this.currentName === 'pounce') action.time = JUMP_CROUCH_FRAME / CLIP_FPS;
    if (this.current && this.current !== action) action.crossFadeFrom(this.current, CROSSFADE, false);
    action.play();
    this.current = action;
    this.currentName = anim;

    // Follow-through: the tail carries on with the body's swing.
    const kick = TAIL_KICKS[anim];
    const root = this.tailSprings[0];
    if (kick && root) {
      root.side.v += kick[0];
      root.lift.v += kick[1];
    }
  }

  update(dt: number, pose: CatPose): void {
    // The mixer only writes a bone when the clip's value changes, so on frames
    // where a clip holds the head or tail still, last frame's look-at and sway
    // would stay on the bone and the next adjustment would stack on top (the
    // head ends up spinning). Put the animated rotation back first.
    for (const [bone, q] of this.animated) bone.quaternion.copy(q);
    // The bone adjustments below need an undistorted skeleton, so the squash
    // comes off here and goes back on at the end.
    this.squash.reset();
    // Winding up follows the charge; letting go fades out over the crossfade
    // into the throw, which picks up from the same pose.
    this.wind = pose.windup >= this.wind ? pose.windup : Math.max(pose.windup, this.wind - dt / CROSSFADE);
    this.windAction?.setEffectiveWeight(this.wind);
    // Longer, quicker strides as she speeds up: the gait clips play at the
    // rate that keeps planted paws still on the floor.
    const clipSpeed = this.currentName === 'walk' ? catModel.walkClipSpeed
      : this.currentName === 'run' ? catModel.runClipSpeed : 0;
    if (this.current && clipSpeed) this.current.timeScale = THREE.MathUtils.clamp(pose.speed / clipSpeed, 0.5, 1.5);
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

    const vyBefore = this.vel.y;
    this.stepTailSprings(dt, catQuat, right);

    // Tail sway: a slow side-to-side wave running down the tail, calmer when
    // moving, plus the follow-through springs. "Side to side" is relative to
    // where the tail points, so a raised tail swings left and right rather
    // than twisting around itself.
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
          const { side, lift } = this.tailSprings[i];
          const angle = Math.sin(this.tailPhase - i * 0.6) * this.tailAmp + side.x;
          // Turning about her right axis lowers the tail, so lift is negated.
          const delta = new THREE.Quaternion().setFromAxisAngle(axis, angle)
            .multiply(new THREE.Quaternion().setFromAxisAngle(right, -lift.x));
          rotateBoneInWorld(bone, delta);
        });
      }
      if (pose.probe) this.brushTail(pose.probe, dt);
    }

    this.squash.update(dt, pose, this.vel, vyBefore, catQuat);
  }

  // The tail against the room: a tail bone that would pass through a chair
  // leg, a wall or the floor bends to slide along it instead, and touching
  // something soaks up some of its swing. Works base to tip, so bending one
  // bone carries the rest of the tail along before they're checked.
  private brushTail(probe: SurfaceProbe, dt: number): void {
    const friction = Math.exp(-TAIL_CONTACT_FRICTION * dt);
    let length = 0.05;
    for (let i = 0; i < this.tail.length; i++) {
      const bone = this.tail[i];
      const from = bone.getWorldPosition(new THREE.Vector3());
      // Bones point along their own +Y. The tip bone has no child to measure
      // to, so it reuses the previous bone's length.
      const next = this.tail[i + 1];
      if (next) length = next.getWorldPosition(new THREE.Vector3()).distanceTo(from);
      const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()));
      const hit = probe(from, dir, length + TAIL_RADIUS);
      // A bone that starts inside something can't be pushed out sensibly.
      if (!hit || hit.dist <= 0 || dir.dot(hit.normal) >= 0) continue;

      // Lift the bone's end onto the surface, a tail's radius off it.
      const surface = from.clone().addScaledVector(dir, hit.dist);
      const end = from.clone().addScaledVector(dir, length);
      const depth = end.clone().sub(surface).dot(hit.normal) - TAIL_RADIUS;
      if (depth >= 0) continue;
      const bent = end.addScaledVector(hit.normal, -depth).sub(from).normalize();
      rotateBoneInWorld(bone, new THREE.Quaternion().setFromUnitVectors(dir, bent));
      const springs = this.tailSprings[i];
      springs.side.v *= friction;
      springs.lift.v *= friction;
    }
  }

  // Tail follow-through. The tail has weight, so when the body speeds up,
  // stops, turns or lands it lags behind and then swings past before
  // settling. The body's change in velocity pushes the base tail spring, and
  // each further bone springs after the one before it, so the motion rolls
  // down to the tip a little late.
  private stepTailSprings(dt: number, catQuat: THREE.Quaternion, right: THREE.Vector3): void {
    const pos = this.object.getWorldPosition(new THREE.Vector3());
    const yaw = this.object.rotation.y;
    if (dt <= 0) return;
    // First frame, or a teleport such as a respawn: nothing to react to.
    if (!this.lastPos || pos.distanceTo(this.lastPos) > 1) {
      this.lastPos = pos;
      this.lastYaw = yaw;
      return;
    }
    // Physics runs at a fixed rate, so per-frame speeds jitter; smooth them.
    const k = Math.min(1, dt / 0.05);
    const oldVel = this.vel.clone();
    this.vel.lerp(pos.clone().sub(this.lastPos).divideScalar(dt), k);
    const dv = this.vel.clone().sub(oldVel);
    const yawRate = THREE.MathUtils.lerp(this.lastYawRate, wrapAngle(yaw - this.lastYaw) / dt, k);
    const dYawRate = yawRate - this.lastYawRate;
    this.lastPos = pos;
    this.lastYaw = yaw;
    this.lastYawRate = yawRate;

    const springs = this.tailSprings;
    if (!springs.length) return;
    const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(catQuat);
    // Speeding up forward drags the tail down; braking flings it up. Moving
    // or turning one way swings it the other way.
    springs[0].lift.v -= TAIL_DRAG.forward * dv.dot(facing) + TAIL_DRAG.vertical * dv.y;
    springs[0].side.v -= TAIL_DRAG.sideways * dv.dot(right) + TAIL_DRAG.turn * dYawRate;

    // Small fixed steps keep the springs stable at low frame rates.
    for (let left = Math.min(dt, 0.1); left > 1e-6; left -= TAIL_STEP) {
      const h = Math.min(left, TAIL_STEP);
      springs.forEach((s, i) => {
        const tune = i === 0 ? TAIL_ROOT : TAIL_FOLLOW;
        s.side.step(i === 0 ? 0 : springs[i - 1].side.x, tune, h);
        s.lift.step(i === 0 ? 0 : springs[i - 1].lift.x, tune, h);
      });
    }
  }
}

// Peak sway per tail bone (radians) when standing still.
const TAIL_SWAY = 0.12;
// Tail thickness kept clear of surfaces (meters), and how quickly touching
// one stops the tail swinging (per second).
const TAIL_RADIUS = 0.02;
const TAIL_CONTACT_FRICTION = 8;

// Tail follow-through tuning. Frequencies in Hz, damping as a fraction of
// critical (lower swings longer). The base bone swings slowest; the others
// chase it a little faster, which delays the motion toward the tip.
const TAIL_ROOT = { hz: 1.4, damping: 0.3, max: 0.3 };
const TAIL_FOLLOW = { hz: 2.4, damping: 0.45, max: 0.4 };
const TAIL_STEP = 1 / 120;
// How hard the body's motion pushes the tail: radians/s of tail swing per
// m/s change in velocity, or per rad/s change in turn rate.
const TAIL_DRAG = { forward: 0.45, vertical: 0.3, sideways: 0.45, turn: 0.12 };
// Extra flick when a move starts: [side, lift] in radians/s. Side is
// toward her right, lift is up.
const TAIL_KICKS: Partial<Record<CatAnim, [number, number]>> = {
  swipe_L: [-1.2, 0.4],
  swipe_R: [1.2, 0.4],
  throw: [0, 1.6],
  trick: [0, 1.2],
  grab: [0, 0.6],
};

// Squash and stretch for the whole body. Scaling by s along one axis and by
// 1/√s across it keeps her volume the same, so she reads as flexible rather
// than shrinking or swelling. She squashes into the jump crouch and on
// landing (harder the faster she lands, then rebounding past neutral), and
// stretches along her flight path, most at takeoff and when falling fast.
class SquashStretch {
  // Sits between the cat's root and the model, so the root's transform stays
  // clean for the game.
  readonly group = new THREE.Group();
  // Stretch amount: s = 1 + e, negative is squash.
  private e = 0;
  private v = 0;
  // Stretch axis in the cat's local frame.
  private axis = new THREE.Vector3(0, 1, 0);
  // Height of the point the body scales about: her feet on the ground, so
  // they stay planted, and her middle in the air.
  private pivot = 0;
  private wasGrounded = true;

  constructor() {
    this.group.matrixAutoUpdate = false;
  }

  reset(): void {
    this.group.matrix.identity();
    this.group.matrixWorldNeedsUpdate = true;
  }

  update(dt: number, pose: CatPose, vel: THREE.Vector3, vyBefore: number, catQuat: THREE.Quaternion): void {
    if (dt > 0) this.step(dt, pose, vel, vyBefore, catQuat);
    const s = 1 + this.e;
    const across = 1 / Math.sqrt(s);
    const r = new THREE.Quaternion().setFromUnitVectors(UP, this.axis);
    this.group.matrix
      .makeTranslation(0, this.pivot, 0)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(r))
      .multiply(new THREE.Matrix4().makeScale(across, s, across))
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(r.invert()))
      .multiply(new THREE.Matrix4().makeTranslation(0, -this.pivot, 0));
    this.group.matrixWorldNeedsUpdate = true;
  }

  private step(dt: number, pose: CatPose, vel: THREE.Vector3, vyBefore: number, catQuat: THREE.Quaternion): void {
    let target = 0;
    const wanted = new THREE.Vector3(0, 1, 0);
    if (pose.grounded) {
      target = -SQUASH.crouch * pose.crouch;
      // Landing: the body keeps going down for a moment after the paws stop.
      // Any stretch from the fall ends the instant the paws touch, which
      // also lets the axis snap upright without a visible jump.
      if (!this.wasGrounded) {
        this.e = Math.min(this.e, 0);
        this.v = Math.min(this.v, 0) - SQUASH.landing * Math.max(0, -vyBefore);
      }
      this.pivot = 0;
    } else {
      target = Math.min(SQUASH.maxStretch, SQUASH.flight * Math.abs(vel.y));
      if (vel.lengthSq() > 0.25) wanted.copy(vel).normalize().applyQuaternion(catQuat.clone().invert());
      this.pivot += (SQUASH.airPivot - this.pivot) * Math.min(1, 10 * dt);
    }
    this.wasGrounded = pose.grounded;

    // The axis is a line, so flip the wanted direction onto the same side
    // rather than swinging through zero at the top of the arc.
    if (wanted.dot(this.axis) < 0) wanted.negate();
    this.axis.lerp(wanted, pose.grounded ? 1 : Math.min(1, 12 * dt)).normalize();

    const w = 2 * Math.PI * SQUASH.hz;
    for (let left = Math.min(dt, 0.1); left > 1e-6; left -= TAIL_STEP) {
      const h = Math.min(left, TAIL_STEP);
      this.v += (-w * w * (this.e - target) - 2 * SQUASH.damping * w * this.v) * h;
      this.e += this.v * h;
    }
    this.e = THREE.MathUtils.clamp(this.e, -SQUASH.maxSquash, SQUASH.maxStretch * 1.3);
  }
}

// Squash and stretch tuning. `crouch` is the squash aimed for at the deepest
// point of the jump crouch, `landing` the squash speed per m/s of landing
// speed, `flight` the stretch per m/s of vertical speed. Frequency in Hz and
// damping as a fraction of critical (lower bounces more).
const SQUASH = {
  crouch: 0.15, landing: 1.5, flight: 0.04,
  maxSquash: 0.25, maxStretch: 0.18,
  airPivot: 0.2,
  hz: 4, damping: 0.35,
};
const UP = new THREE.Vector3(0, 1, 0);

// A damped spring on one angle, pulled toward a target.
class Spring {
  x = 0;
  v = 0;

  step(target: number, tune: { hz: number; damping: number; max: number }, h: number): void {
    const w = 2 * Math.PI * tune.hz;
    this.v += (-w * w * (this.x - target) - 2 * tune.damping * w * this.v) * h;
    this.x += this.v * h;
    if (Math.abs(this.x) > tune.max) {
      this.x = Math.sign(this.x) * tune.max;
      this.v = 0;
    }
  }
}

// A one-frame clip holding `clip`'s pose at `time` (seconds).
function poseAt(clip: THREE.AnimationClip, name: string, time: number): THREE.AnimationClip {
  const tracks = clip.tracks.map((track) => {
    // Typed as missing, but every track has it (GLTFLoader overrides it for
    // cubic-spline tracks).
    const interpolant = (track as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant();
    const value = Array.from(interpolant.evaluate(time) as ArrayLike<number>);
    const Track = track.constructor as new (name: string, times: number[], values: number[]) => THREE.KeyframeTrack;
    return new Track(track.name, [0], value);
  });
  // A non-zero length so the mixer can loop it; the single key holds throughout.
  return new THREE.AnimationClip(name, 1, tracks);
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

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
