import * as THREE from 'three';
import { tuning } from '../config';
import type { GameAudio } from './audio';
import type { CameraRig } from './CameraRig';
import type { CatAnim, CatVisual } from './catVisual';
import type { Input, MouseButton } from './input';
import { DYNAMIC_ONLY, RAPIER, STATIC_ONLY, toVec } from './physics';
import type { Prop, PropSystem } from './props';

type World = InstanceType<typeof RAPIER.World>;
type RigidBody = InstanceType<typeof RAPIER.RigidBody>;

type State = 'free' | 'climb' | 'holding' | 'trick';
type Paw = 'L' | 'R';

const CENTER_OFFSET = tuning.catHalfHeight + tuning.catRadius;
const UP = new THREE.Vector3(0, 1, 0);

// What the HUD needs to show this frame.
export interface CatHud {
  spikeWindow: boolean;
  charge: number | null;
}

export class Cat {
  readonly body: RigidBody;
  readonly colliderHandle: number;
  private collider: InstanceType<typeof RAPIER.Collider>;
  private controller: InstanceType<typeof RAPIER.KinematicCharacterController>;

  private state: State = 'free';
  private yaw = 0;
  private targetYaw = 0;
  private hv = new THREE.Vector3();
  private vy = 0;
  private grounded = true;
  private moveDir = new THREE.Vector3();
  private running = false;
  private jumpQueued = false;
  private time = 0;

  private animLockUntil = 0;
  private pendingPress: { button: MouseButton; at: number } | null = null;
  private swipes: { paw: Paw; t: number; hit: boolean }[] = [];
  private cooldown: Record<Paw, number> = { L: 0, R: 0 };

  private climb: { from: THREE.Vector3; mid: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;

  private held: Prop | null = null;
  private waitRelease = false;
  private chargeStart: number | null = null;
  private trick: { prop: Prop; t: number; attempted: boolean } | null = null;

  readonly hud: CatHud = { spikeWindow: false, charge: null };

  constructor(
    private world: World,
    readonly visual: CatVisual,
    private spawn: THREE.Vector3,
    private props: PropSystem,
    private audio: GameAudio,
  ) {
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y + CENTER_OFFSET, spawn.z),
    );
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.capsule(tuning.catHalfHeight, tuning.catRadius).setMass(tuning.catMass),
      this.body,
    );
    this.colliderHandle = this.collider.handle;

    this.controller = world.createCharacterController(0.01);
    this.controller.enableAutostep(0.1, 0.05, true);
    this.controller.enableSnapToGround(0.08);
    this.controller.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(50));
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.controller.setCharacterMass(tuning.catMass);
  }

  get feet(): THREE.Vector3 {
    return toVec(this.body.translation()).setY(this.body.translation().y - CENTER_OFFSET);
  }

  // Reads input once per rendered frame.
  handleInput(input: Input, cam: CameraRig): void {
    const now = this.time;
    const fwd = cam.forwardFlat();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const x = (input.down('KeyD', 'ArrowRight') ? 1 : 0) - (input.down('KeyA', 'ArrowLeft') ? 1 : 0);
    const z = (input.down('KeyW', 'ArrowUp') ? 1 : 0) - (input.down('KeyS', 'ArrowDown') ? 1 : 0);
    this.moveDir.copy(fwd).multiplyScalar(z).addScaledVector(right, x);
    if (this.moveDir.lengthSq() > 1) this.moveDir.normalize();
    this.running = input.down('ShiftLeft', 'ShiftRight');
    if (input.pressed('Space')) this.jumpQueued = true;

    if (this.state === 'free') this.handleFreeButtons(input, cam, now);
    else if (this.state === 'holding') this.handleHoldingInput(input, cam, now);
    else if (this.state === 'trick') this.handleTrickInput(input, cam);

    if (this.state === 'holding' || this.state === 'trick') this.targetYaw = cam.yaw;
    this.cam = cam;
  }

  private cam: CameraRig | null = null;

  // Advances the cat by one fixed physics step.
  step(dt: number): void {
    this.time += dt;
    for (const paw of ['L', 'R'] as Paw[]) this.cooldown[paw] = Math.max(0, this.cooldown[paw] - dt);

    if (this.pendingPress && this.time - this.pendingPress.at > tuning.grabChordWindow) {
      this.startSwipe(this.pendingPress.button === 'left' ? 'L' : 'R');
      this.pendingPress = null;
    }
    this.updateSwipes(dt);

    switch (this.state) {
      case 'climb':
        this.stepClimb(dt);
        break;
      case 'holding':
        this.stepHolding();
        this.move(dt, false);
        break;
      case 'trick':
        this.stepTrick(dt);
        this.move(dt, false);
        break;
      default:
        this.move(dt, true);
    }

    this.yaw = approachAngle(this.yaw, this.targetYaw, tuning.turnSpeed * dt);

    if (this.feet.y < -2) this.respawn();
  }

  // Updates the visual after physics, once per rendered frame.
  updateVisual(dt: number): void {
    const obj = this.visual.object;
    obj.position.copy(this.feet);
    obj.rotation.y = this.yaw;
    const speed = Math.hypot(this.hv.x, this.hv.z);

    if (this.state === 'free' && this.time >= this.animLockUntil) {
      if (!this.grounded) this.play('jump');
      else if (speed > tuning.walkSpeed * 1.2) this.play('run');
      else if (speed > 0.15) this.play('walk');
      else this.play('idle');
    }

    // While holding, the hold animation already aims the head at the item.
    // During a trick, follow the tossed item. When running or in the air,
    // keep looking ahead: nearby props sweep past too fast to track.
    // Otherwise look at the nearest prop ahead, ignoring ones in flight so the
    // head doesn't chase what she just knocked away.
    let lookAt: THREE.Vector3 | null = null;
    const running = speed > tuning.walkSpeed * 1.2;
    if (this.trick) lookAt = this.trick.prop.object.position;
    else if (!this.held && !running && this.grounded) {
      const headPos = this.feet.addScaledVector(UP, 0.25);
      const facing = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      lookAt = this.props.nearest(headPos, 1.6, { forward: facing, resting: true })?.object.position ?? null;
    }
    this.visual.update(dt, { speed, lookAt });

    this.hud.charge = this.chargeStart !== null ? Math.min(1, (this.time - this.chargeStart) / tuning.throwChargeTime) : null;
  }

  // Drops whatever is held; used on room reset.
  releaseAll(): void {
    if (this.held) this.props.setHeld(this.held, false);
    this.held = null;
    this.trick = null;
    this.chargeStart = null;
    this.hud.spikeWindow = false;
    this.state = 'free';
  }

  respawn(): void {
    this.releaseAll();
    this.body.setTranslation({ x: this.spawn.x, y: this.spawn.y + CENTER_OFFSET, z: this.spawn.z }, true);
    this.hv.set(0, 0, 0);
    this.vy = 0;
    this.climb = null;
  }

  // --- Movement -----------------------------------------------------------

  private move(dt: number, canMove: boolean): void {
    const speed = this.running ? tuning.runSpeed : tuning.walkSpeed;
    const wanted = canMove ? this.moveDir.clone().multiplyScalar(speed) : new THREE.Vector3();
    const accel = this.grounded ? 20 : 6;
    this.hv.lerp(wanted, Math.min(1, accel * dt));

    if (canMove && this.moveDir.lengthSq() > 0.01 && this.swipes.length === 0) {
      this.targetYaw = Math.atan2(-this.moveDir.x, -this.moveDir.z);
    }

    if (this.jumpQueued && this.grounded && canMove) {
      this.vy = Math.sqrt(2 * tuning.gravity * tuning.jumpHeight);
      this.grounded = false;
    }
    this.jumpQueued = false;
    this.vy -= tuning.gravity * dt;

    const desired = { x: this.hv.x * dt, y: this.vy * dt, z: this.hv.z * dt };
    // The held item sits partly inside the cat's capsule. Treating it as an
    // obstacle would push the cat away from it every step, and since the
    // item follows the cat, she would slide backwards for as long as she holds it.
    const heldBody = this.held?.body.handle;
    this.controller.computeColliderMovement(
      this.collider, desired, undefined, undefined,
      heldBody === undefined ? undefined : (c) => c.parent()?.handle !== heldBody,
    );
    const moved = this.controller.computedMovement();
    const wasGrounded = this.grounded;
    this.grounded = this.controller.computedGrounded();

    if (this.grounded && this.vy < 0) this.vy = 0;
    if (desired.y > 0 && moved.y < desired.y * 0.5) this.vy = 0; // bumped head
    if (this.grounded && !wasGrounded && this.state === 'free') this.playOneShot('land', 0.12);

    const pos = this.body.translation();
    this.body.setNextKinematicTranslation({ x: pos.x + moved.x, y: pos.y + moved.y, z: pos.z + moved.z });

    if (!this.grounded && canMove && this.moveDir.lengthSq() > 0.09) this.tryScramble();
  }

  // Mid-air: if a ledge is in front and within reach, scramble up onto it.
  private tryScramble(): void {
    const center = toVec(this.body.translation());
    const dir = this.moveDir.clone().normalize();
    const wall = this.world.castRayAndGetNormal(
      new RAPIER.Ray(center, dir), tuning.catRadius + 0.2, true, STATIC_ONLY,
    );
    if (!wall || Math.abs(wall.normal.y) > 0.3) return;

    const feetY = center.y - CENTER_OFFSET;
    const probe = center.clone().addScaledVector(dir, wall.timeOfImpact + tuning.catRadius + 0.05);
    probe.y = feetY + tuning.scrambleReach + 0.05;
    const down = this.world.castRayAndGetNormal(
      new RAPIER.Ray(probe, { x: 0, y: -1, z: 0 }), tuning.scrambleReach + 0.03, true, STATIC_ONLY,
    );
    if (!down || down.normal.y < 0.7 || down.timeOfImpact < 0.01) return;
    const ledgeY = probe.y - down.timeOfImpact;

    // Room for the cat on top?
    const top = new THREE.Vector3(probe.x, ledgeY + 0.02, probe.z);
    if (this.world.castRay(new RAPIER.Ray(top, { x: 0, y: 1, z: 0 }), CENTER_OFFSET * 2, true, STATIC_ONLY)) return;

    const restY = ledgeY + CENTER_OFFSET + 0.02;
    this.climb = {
      from: center,
      mid: new THREE.Vector3(center.x, restY, center.z),
      to: new THREE.Vector3(probe.x, restY, probe.z),
      t: 0,
    };
    this.state = 'climb';
    this.targetYaw = Math.atan2(-dir.x, -dir.z);
    this.vy = 0;
    this.hv.set(0, 0, 0);
    this.play('climb');
  }

  private stepClimb(dt: number): void {
    const c = this.climb!;
    c.t += dt / tuning.scrambleDuration;
    const p = c.t < 0.55
      ? c.from.clone().lerp(c.mid, smooth(c.t / 0.55))
      : c.mid.clone().lerp(c.to, smooth((c.t - 0.55) / 0.45));
    this.body.setNextKinematicTranslation(p);
    if (c.t >= 1) {
      this.climb = null;
      this.state = 'free';
      this.grounded = true;
    }
  }

  // --- Swipes ---------------------------------------------------------------

  private handleFreeButtons(input: Input, cam: CameraRig, now: number): void {
    for (const ev of input.buttonEvents) {
      if (!ev.down) continue;
      const other: MouseButton = ev.button === 'left' ? 'right' : 'left';
      const chord = this.pendingPress && this.pendingPress.button === other && now - this.pendingPress.at <= tuning.grabChordWindow;
      if (chord || input.buttons[other]) {
        this.pendingPress = null;
        this.tryGrab(cam);
      } else {
        this.pendingPress = { button: ev.button, at: now };
      }
    }
  }

  private startSwipe(paw: Paw): void {
    if (this.state !== 'free' || this.cooldown[paw] > 0) return;
    this.cooldown[paw] = tuning.swipeCooldown;
    this.swipes.push({ paw, t: 0, hit: false });
    // Face the aim instantly so the paw lands where the player is looking.
    if (this.cam) this.yaw = this.targetYaw = this.cam.yaw;
    this.playOneShot(paw === 'L' ? 'swipe_L' : 'swipe_R', 0.3);
    this.audio.swipe();
  }

  private updateSwipes(dt: number): void {
    for (const s of this.swipes) {
      s.t += dt;
      if (!s.hit && s.t >= tuning.swipeWindup) {
        s.hit = true;
        this.swipeHit(s.paw);
      }
    }
    this.swipes = this.swipes.filter((s) => s.t < 0.3);
  }

  private swipeHit(paw: Paw): void {
    const facing = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-facing.z, 0, facing.x);
    const side = paw === 'L' ? -1 : 1;
    const pawPos = this.feet
      .addScaledVector(UP, 0.18)
      .addScaledVector(facing, 0.3)
      .addScaledVector(right, side * 0.08);

    const aim = this.cam ? this.cam.forwardFlat() : facing.clone();
    // Left paw kicks things a little to the right, and vice versa.
    const dir = aim
      .multiplyScalar(1)
      .addScaledVector(right, -side * tuning.swipeSideKick)
      .addScaledVector(UP, tuning.swipeLift)
      .normalize();

    // Collect first: Rapier doesn't allow changing bodies inside a query callback.
    const hit = new Map<number, RigidBody>();
    this.world.intersectionsWithShape(
      pawPos, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Ball(tuning.swipeRadius),
      (collider) => {
        const body = collider.parent();
        if (body) hit.set(body.handle, body);
        return true;
      },
      DYNAMIC_ONLY,
    );
    for (const body of hit.values()) {
      const mass = body.mass();
      // Heavy things still move, just less: cartoon physics.
      const speed = tuning.swipeSpeed / (1 + Math.max(0, mass - 1) * 0.35);
      body.applyImpulse(dir.clone().multiplyScalar(speed * mass), true);
      body.applyTorqueImpulse({ x: rand(0.02) * mass, y: rand(0.02) * mass, z: rand(0.02) * mass }, true);
    }
  }

  // --- Grab, throw, trick ------------------------------------------------

  private tryGrab(cam: CameraRig): void {
    if (!this.grounded) return;
    this.targetYaw = cam.yaw;
    const facing = cam.forwardFlat();
    const reachFrom = this.feet.addScaledVector(facing, 0.25).addScaledVector(UP, 0.15);
    const prop = this.props.nearest(reachFrom, tuning.grabReach, { grabbable: true });
    if (!prop) {
      // Nothing to grab: a two-paw slap instead.
      this.cooldown.L = this.cooldown.R = 0;
      this.startSwipe('L');
      this.startSwipe('R');
      return;
    }
    this.held = prop;
    this.props.setHeld(prop, true);
    this.state = 'holding';
    this.waitRelease = true;
    this.hv.set(0, 0, 0);
    this.swipes = [];
    this.playOneShot('grab', 0.25);
  }

  private holdPoint(): THREE.Vector3 {
    const facing = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    return this.feet.addScaledVector(UP, tuning.holdHeight).addScaledVector(facing, tuning.holdForward);
  }

  private stepHolding(): void {
    const prop = this.held!;
    if (prop.broken) {
      this.releaseAll();
      return;
    }
    prop.body.setNextKinematicTranslation(this.holdPoint());
    if (this.time > this.animLockUntil) this.play('hold');
  }

  private handleHoldingInput(input: Input, cam: CameraRig, now: number): void {
    if (this.waitRelease) {
      if (!input.buttons.left && !input.buttons.right) this.waitRelease = false;
      return;
    }
    for (const ev of input.buttonEvents) {
      if (ev.down && this.chargeStart === null) this.chargeStart = now;
      if (!ev.down && this.chargeStart !== null) {
        this.throwHeld(cam, Math.min(1, (now - this.chargeStart) / tuning.throwChargeTime));
        return;
      }
    }
    if (this.chargeStart === null && input.pressed('KeyF')) this.startTrick();
  }

  private throwHeld(cam: CameraRig, power: number): void {
    const prop = this.held!;
    this.props.setHeld(prop, false);
    const speed = THREE.MathUtils.lerp(tuning.throwMinSpeed, tuning.throwMaxSpeed, power);
    const dir = cam.aim().addScaledVector(UP, 0.15).normalize();
    prop.body.setLinvel(dir.multiplyScalar(speed), true);
    prop.body.setAngvel({ x: rand(6), y: rand(6), z: rand(6) }, true);
    this.held = null;
    this.chargeStart = null;
    this.state = 'free';
    this.playOneShot('throw', 0.3);
    this.audio.swipe();
  }

  private startTrick(): void {
    const prop = this.held!;
    this.props.setHeld(prop, false);
    prop.body.setLinvel({ x: 0, y: tuning.trickTossSpeed, z: 0 }, true);
    prop.body.setAngvel({ x: rand(3), y: rand(3), z: rand(3) }, true);
    this.held = null;
    this.trick = { prop, t: 0, attempted: false };
    this.state = 'trick';
    this.play('trick');
  }

  private spikeWindowOpen(): boolean {
    if (!this.trick || this.trick.attempted) return false;
    const vy = this.trick.prop.body.linvel().y;
    // Only once the toss has started slowing down.
    return this.trick.t > 0.05 && vy < tuning.spikeOpenVy && vy > tuning.spikeCloseVy;
  }

  private handleTrickInput(input: Input, cam: CameraRig): void {
    const trick = this.trick!;
    if (trick.attempted || !input.buttonEvents.some((e) => e.down)) return;
    trick.attempted = true;
    const inWindow = this.lastWindow;
    this.playOneShot('swipe_R', 0.3);
    this.audio.swipe();
    if (inWindow) {
      const dir = cam.aim().addScaledVector(UP, 0.05).normalize();
      trick.prop.body.setLinvel(dir.multiplyScalar(tuning.spikeSpeed), true);
      trick.prop.body.setAngvel({ x: rand(15), y: rand(15), z: rand(15) }, true);
    }
  }

  // Window state as of the last physics step (input arrives between steps).
  private lastWindow = false;

  private stepTrick(dt: number): void {
    const trick = this.trick!;
    trick.t += dt;
    this.lastWindow = this.spikeWindowOpen();
    this.hud.spikeWindow = this.lastWindow;
    const fallen = trick.prop.object.position.y < this.feet.y + 0.25 && trick.t > 0.3;
    if (trick.prop.broken || fallen || trick.t > 1.5) {
      this.trick = null;
      this.hud.spikeWindow = false;
      this.state = 'free';
    }
  }

  // --- Animation helpers -------------------------------------------------

  private currentAnim: CatAnim | null = null;

  // Starts `anim` unless it's already playing.
  private play(anim: CatAnim): void {
    if (anim === this.currentAnim) return;
    this.currentAnim = anim;
    this.visual.play(anim);
  }

  // Restarts `anim` and keeps locomotion from overriding it for `duration`.
  private playOneShot(anim: CatAnim, duration: number): void {
    this.currentAnim = anim;
    this.visual.play(anim);
    this.animLockUntil = this.time + duration;
  }
}

function approachAngle(from: number, to: number, maxStep: number): number {
  let diff = ((to - from + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return from + THREE.MathUtils.clamp(diff, -maxStep, maxStep);
}

function smooth(t: number): number {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function rand(amount: number): number {
  return (Math.random() - 0.5) * 2 * amount;
}
