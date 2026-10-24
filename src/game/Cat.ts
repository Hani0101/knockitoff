import * as THREE from 'three';
import { tuning } from '../config';
import type { GameAudio } from './audio';
import type { CameraRig } from './CameraRig';
import type { CatAnim, CatVisual, SurfaceProbe } from './catVisual';
import type { Input, MouseButton } from './input';
import { DYNAMIC_ONLY, RAPIER, STATIC_ONLY, toVec } from './physics';
import type { Prop, PropSystem } from './props';

type World = InstanceType<typeof RAPIER.World>;
type RigidBody = InstanceType<typeof RAPIER.RigidBody>;

type State = 'free' | 'pounce' | 'climb' | 'holding' | 'trick';
type Paw = 'L' | 'R';

// A surface she's leaping onto, or down to: getting ready ('pounce' state),
// then in the air until she lands or scrambles.
interface Leap {
  // Getting down from where she is, rather than up onto something.
  down: boolean;
  // Flat unit direction toward it.
  dir: THREE.Vector3;
  // Where she aims to land, on top of it.
  land: THREE.Vector3;
  // Distance from her feet to its near edge.
  edge: number;
  // Time spent crouched so far.
  t: number;
  airborne: boolean;
  // Too high to clear: she scrambles up once she reaches the edge.
  scramble: boolean;
  // Her feet when she took off.
  from: THREE.Vector3;
}

const CENTER_OFFSET = tuning.catHalfHeight + tuning.catRadius;
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = { x: 0, y: -1, z: 0 };
// Getting down, she creeps until her middle is this far short of the edge.
const BRINK = 0.1;

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
  // When the crouch before a jump ends and she leaves the ground.
  private jumpAt: number | null = null;
  private leap: Leap | null = null;
  // Walking velocity while getting ready to leap (creeping to the brink).
  private creep = new THREE.Vector3();
  private time = 0;
  // Height of the last surface she stood on, and until when she's glancing
  // at her footing after reaching a new one.
  private groundY: number | null = null;
  private glanceUntil = 0;

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
  }

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
      case 'pounce':
        this.stepPounce(dt);
        this.move(dt, false);
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
      // A leap keeps its animation all the way down, even on steps where she
      // still touches the ground. Getting down, she drops front paws first
      // (the end of descend).
      if (this.leap?.airborne) this.play(this.leap.down ? 'descend' : 'jump');
      else if (!this.grounded) this.play('jump');
      else if (speed > tuning.walkSpeed * 1.2) this.play('run');
      else if (speed > 0.15) this.play('walk');
      else this.play('idle');
    }

    // While holding, the hold animation already aims the head at the item.
    // During a trick, follow the tossed item. When running or in the air,
    // keep looking ahead: nearby props sweep past too fast to track.
    // Otherwise look at the nearest prop ahead, ignoring ones in flight so the
    // head doesn't chase what she just knocked away.
    // Exploring comes before props: at an edge she peers over it at the
    // floor below, and on a surface she's just reached she checks her footing.
    // Leaping onto something, she keeps her eyes on where she'll land.
    let lookAt: THREE.Vector3 | null = null;
    const running = speed > tuning.walkSpeed * 1.2;
    if (this.trick) lookAt = this.trick.prop.object.position;
    else if (this.leap) lookAt = this.leap.land;
    else if (!this.held && !running && this.grounded) {
      const headPos = this.feet.addScaledVector(UP, 0.25);
      const facing = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      lookAt = (speed < tuning.walkSpeed * 0.6 ? this.edgeAhead(facing) : null)
        ?? (this.time < this.glanceUntil ? this.feet.addScaledVector(facing, 0.5) : null)
        ?? this.props.nearest(headPos, 1.6, { forward: facing, resting: true })?.object.position ?? null;
    }
    this.hud.charge = this.charge();
    // The pounce and descend clips already crouch; the squash only adds
    // tension as the leap gets closer, less when reaching down.
    const crouch = this.state === 'pounce' && this.leap
      ? (this.leap.down ? 0.3 : 0.6) * smooth(this.leap.t / windupFor(this.leap))
      : this.jumpAt === null ? 0 : 1 - (this.jumpAt - this.time) / tuning.jumpWindup;
    this.visual.update(dt, {
      speed, lookAt, windup: smooth(this.hud.charge ?? 0),
      grounded: this.grounded, crouch: THREE.MathUtils.clamp(crouch, 0, 1),
      probe: this.probe,
    });
  }

  // If she's standing at a drop, the point on the floor below it she'd peer
  // at, out past the edge; otherwise null.
  private edgeAhead(facing: THREE.Vector3): THREE.Vector3 | null {
    const feet = this.feet;
    for (const reach of [0.2, 0.3, 0.4]) {
      const from = feet.clone().addScaledVector(facing, reach);
      from.y += 0.05;
      const hit = this.world.castRay(new RAPIER.Ray(from, DOWN), 3, true, STATIC_ONLY);
      if (hit && hit.timeOfImpact - 0.05 < tuning.edgeDrop) continue;
      const below = hit ? from.y - hit.timeOfImpact : feet.y - 1;
      return from.addScaledVector(facing, 0.3).setY(below);
    }
    return null;
  }

  // Lets the visual's tail feel the room.
  private probe: SurfaceProbe = (from, dir, maxDist) => {
    const hit = this.world.castRayAndGetNormal(
      new RAPIER.Ray(from, dir), maxDist, true, undefined, undefined, this.collider, this.held?.body,
    );
    return hit ? { dist: hit.timeOfImpact, normal: toVec(hit.normal) } : null;
  };

  // Notes the surface she's standing on; reaching one at a new height makes
  // her glance down at her footing.
  private arrive(feetY: number): void {
    if (this.groundY !== null && Math.abs(feetY - this.groundY) > tuning.newSurfaceStep) {
      this.glanceUntil = this.time + tuning.footingGlance;
    }
    this.groundY = feetY;
  }

  // Throw charge from 0 to 1 while a button is held, or null.
  private charge(): number | null {
    return this.chargeStart !== null ? Math.min(1, (this.time - this.chargeStart) / tuning.throwChargeTime) : null;
  }

  // Drops whatever is held; used on room reset.
  releaseAll(): void {
    if (this.held) this.props.setHeld(this.held, false);
    this.held = null;
    this.trick = null;
    this.chargeStart = null;
    this.hud.spikeWindow = false;
    this.leap = null;
    this.state = 'free';
  }

  respawn(): void {
    this.releaseAll();
    this.body.setTranslation({ x: this.spawn.x, y: this.spawn.y + CENTER_OFFSET, z: this.spawn.z }, true);
    this.hv.set(0, 0, 0);
    this.vy = 0;
    this.jumpAt = null;
    this.groundY = null;
    this.climb = null;
  }

  // --- Movement -----------------------------------------------------------

  private move(dt: number, canMove: boolean): void {
    // A leap flies its computed arc; steering would make her miss.
    const leaping = this.leap?.airborne ?? false;
    const speed = this.running ? tuning.runSpeed : tuning.walkSpeed;
    const wanted = canMove ? this.moveDir.clone().multiplyScalar(speed) : this.creep.clone();
    const accel = this.grounded ? 20 : 6;
    if (!leaping) this.hv.lerp(wanted, Math.min(1, accel * dt));

    if (canMove && !leaping && this.moveDir.lengthSq() > 0.01 && this.swipes.length === 0) {
      this.targetYaw = Math.atan2(-this.moveDir.x, -this.moveDir.z);
    }

    // With something to leap onto ahead, get ready and leap at it; at an
    // edge with nothing higher ahead, get down. Otherwise crouch briefly (the
    // jump animation opens with it), then jump. The crouch is cancelled if
    // she leaves the ground or stops being free to move.
    if (this.jumpQueued && this.grounded && canMove && this.jumpAt === null) {
      const leap = this.findLeap() ?? this.descentAlong(this.heading(), tuning.descendReach);
      if (leap) {
        this.startPounce(leap);
      } else {
        this.jumpAt = this.time + tuning.jumpWindup;
        this.playOneShot('jump', tuning.jumpWindup + 0.05);
      }
    }
    this.jumpQueued = false;

    // Walking (not running) into a drop, she gets down carefully instead of
    // stepping off into thin air.
    if (canMove && this.grounded && !this.leap && !this.running && this.jumpAt === null && this.moveDir.lengthSq() > 0.09) {
      const descent = this.descentAlong(this.moveDir.clone().normalize(), tuning.catRadius + 0.05);
      if (descent) this.startPounce(descent);
    }
    if (this.jumpAt !== null && (!this.grounded || !canMove)) this.jumpAt = null;
    if (this.jumpAt !== null && this.time >= this.jumpAt) {
      this.jumpAt = null;
      this.vy = Math.sqrt(2 * tuning.gravity * tuning.jumpHeight);
      this.grounded = false;
    }
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
    // The step she takes off on can still report ground under her; that's
    // not a landing. A leap can also reach its surface while still rising
    // (stepping up over the edge), so it lands once she stops going up.
    // Getting down, her rounded underside can catch the edge she's leaving;
    // she's only down once she's below it.
    const pos = this.body.translation();
    const feetY = pos.y + moved.y - CENTER_OFFSET;
    const onEdgeLeft = leaping && this.leap!.down && feetY > this.leap!.from.y - tuning.catRadius - 0.05;
    const landed = this.grounded && this.vy <= 0 && (!wasGrounded || leaping) && !onEdgeLeft;
    if (landed && this.state === 'free') this.playOneShot('land', 0.12);

    this.body.setNextKinematicTranslation({ x: pos.x + moved.x, y: feetY + CENTER_OFFSET, z: pos.z + moved.z });
    if (landed) this.arrive(feetY);
    if (leaping && landed) this.leap = null;

    if (!this.grounded && canMove) {
      if (this.leap?.scramble) this.leapScramble();
      else if (!leaping && this.moveDir.lengthSq() > 0.09) this.tryScramble(this.moveDir.clone().normalize());
    }
  }

  // --- Leaping onto things ---------------------------------------------

  // Something ahead worth leaping onto: higher than a step but within jump
  // and scramble reach, deep and flat enough to stand on, with room on top
  // and nothing in the way. Looks where she's heading (or facing), then a
  // little to either side.
  private findLeap(): Leap | null {
    const ahead = this.heading();
    for (const turn of [0, 0.35, -0.35]) {
      const leap = this.leapAlong(ahead.clone().applyAxisAngle(UP, turn));
      if (leap) return leap;
    }
    return null;
  }

  private leapAlong(dir: THREE.Vector3): Leap | null {
    const feet = this.feet;
    const maxRise = tuning.jumpHeight + tuning.scrambleReach - 0.1;
    const fromY = feet.y + maxRise + 0.05;
    // Height of whatever is below `fromY`, `d` ahead of her feet.
    const topAt = (d: number): number | null => {
      const from = { x: feet.x + dir.x * d, y: fromY, z: feet.z + dir.z * d };
      const hit = this.world.castRay(new RAPIER.Ray(from, DOWN), fromY - feet.y + 0.5, true, STATIC_ONLY);
      return hit ? fromY - hit.timeOfImpact : null;
    };

    for (let d = tuning.catRadius; d <= tuning.leapRange; d += 0.05) {
      const top = topAt(d);
      if (top === null || top - feet.y < tuning.leapMinRise) continue;
      // A wall, or something too tall to get up.
      if (top - feet.y > maxRise) return null;
      // Deep and flat enough to stand on.
      for (const further of [0.15, 0.3]) {
        const next = topAt(d + further);
        if (next === null || Math.abs(next - top) > 0.03) return null;
      }
      const edge = d - 0.025;
      const land = new THREE.Vector3(feet.x + dir.x * (edge + 0.2), top, feet.z + dir.z * (edge + 0.2));
      const leap: Leap = { down: false, dir, land, edge, t: 0, airborne: false, scramble: false, from: feet };
      // Room to stand on top, and a clear flight there.
      const above = { x: land.x, y: top + 0.02, z: land.z };
      if (this.world.castRay(new RAPIER.Ray(above, UP), CENTER_OFFSET * 2, true, STATIC_ONLY)) return null;
      return this.arcClear(feet, leap) ? leap : null;
    }
    return null;
  }

  // Getting down: the brink ahead (within `maxEdge` of her feet) and a clear,
  // flat spot below it to hop down to, on the floor or anything lower. Tries
  // landing close to the edge first, then a little further out.
  private descentAlong(dir: THREE.Vector3, maxEdge: number): Leap | null {
    const feet = this.feet;
    // How far down the ground is, `d` ahead of her feet, or null if it's
    // further than she'd jump down.
    const dropAt = (d: number): number | null => {
      const from = { x: feet.x + dir.x * d, y: feet.y + 0.05, z: feet.z + dir.z * d };
      const hit = this.world.castRay(new RAPIER.Ray(from, DOWN), tuning.descendMaxDrop + 0.1, true, STATIC_ONLY);
      return hit ? hit.timeOfImpact - 0.05 : null;
    };

    for (let d = 0.05; d <= maxEdge; d += 0.05) {
      const drop = dropAt(d);
      if (drop !== null && drop < tuning.edgeDrop) continue;
      if (drop === null) return null;
      const edge = d - 0.025;
      for (const out of [0.3, 0.45, 0.6]) {
        const landDrop = dropAt(edge + out);
        if (landDrop === null || landDrop < tuning.edgeDrop) continue;
        const beyond = dropAt(edge + out + 0.15);
        if (beyond === null || Math.abs(beyond - landDrop) > 0.03) continue;
        const land = new THREE.Vector3(feet.x + dir.x * (edge + out), feet.y - landDrop, feet.z + dir.z * (edge + out));
        const above = { x: land.x, y: land.y + 0.02, z: land.z };
        if (this.world.castRay(new RAPIER.Ray(above, UP), CENTER_OFFSET * 2, true, STATIC_ONLY)) continue;
        const leap: Leap = { down: true, dir, land, edge, t: 0, airborne: false, scramble: false, from: feet };
        // Checked from the brink, where she'll go from after creeping up to it.
        const brink = feet.clone().addScaledVector(dir, Math.max(0, edge - BRINK));
        if (this.arcClear(brink, leap)) return leap;
      }
      return null;
    }
    return null;
  }

  // Where she's heading, or facing if she isn't moving.
  private heading(): THREE.Vector3 {
    return this.moveDir.lengthSq() > 0.01
      ? this.moveDir.clone().normalize()
      : new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  // The leap from `feet`: take-off velocity, flight time, and whether it
  // can't clear the surface and has to end in a scramble at the edge.
  private planLeap(feet: THREE.Vector3, leap: Leap): { hv: THREE.Vector3; vy: number; time: number; scramble: boolean } {
    const g = tuning.gravity;
    const rise = leap.land.y - feet.y;
    // Up: clear the surface. Down: just a small hop out from the edge.
    const above = leap.down ? tuning.descendHop : tuning.leapClearance;
    const peak = Math.min(Math.max(rise, 0) + above, tuning.jumpHeight);
    const vy = Math.sqrt(2 * g * peak);
    const scramble = peak - rise <= 0.03;
    const toLand = new THREE.Vector3(leap.land.x - feet.x, 0, leap.land.z - feet.z);
    const dist = scramble ? Math.max(0, leap.edge - tuning.catRadius) : toLand.length();
    const time = scramble ? vy / g : vy / g + Math.sqrt((2 * (peak - rise)) / g);
    const hv = (scramble ? leap.dir.clone() : toLand.normalize()).multiplyScalar(dist / time);
    return { hv, vy, time, scramble };
  }

  // Sweeps her body along the leap's arc: true if nothing is in the way. A
  // leap that ends in a scramble is only checked up to the edge.
  private arcClear(feet: THREE.Vector3, leap: Leap): boolean {
    const plan = this.planLeap(feet, leap);
    const body = new RAPIER.Capsule(tuning.catHalfHeight, tuning.catRadius);
    const level = { x: 0, y: 0, z: 0, w: 1 };
    const steps = 12;
    // Getting down, how far ahead of `feet` the edge she leaves is.
    const edgeAhead = leap.edge - feet.clone().sub(leap.from).setY(0).dot(leap.dir);
    for (let i = 1; i <= steps; i++) {
      const t = (plan.time * i) / steps;
      const across = plan.hv.clone().multiplyScalar(t);
      if (plan.scramble && across.length() > leap.edge - tuning.catRadius - 0.03) break;
      // Lifted a little so resting on the surface she leaves or lands on
      // doesn't count. Getting down, not once she's past the edge: grazing
      // its corner on the way down would snag her.
      const pastEdge = leap.down && i < steps && across.length() > edgeAhead;
      const lift = pastEdge ? 0.005 : 0.04;
      const y = feet.y + plan.vy * t - (tuning.gravity * t * t) / 2 + CENTER_OFFSET + lift;
      const at = { x: feet.x + across.x, y, z: feet.z + across.z };
      if (this.world.intersectionWithShape(at, level, body, STATIC_ONLY)) return false;
    }
    return true;
  }

  private startPounce(leap: Leap): void {
    this.leap = leap;
    this.state = 'pounce';
    this.targetYaw = Math.atan2(-leap.dir.x, -leap.dir.z);
    this.playOneShot(leap.down ? 'descend' : 'pounce', 0);
  }

  // Getting ready, with her eyes on the target: crouched for a leap up, or
  // creeping to the brink and reaching down for a way down. Then the leap:
  // an arc peaking a little above the surface (or as high as she can jump),
  // or a small hop out from the edge, timed so she comes down on it. Too
  // high to clear, she aims to meet the edge at the top of the jump and
  // scrambles up.
  private stepPounce(dt: number): void {
    const leap = this.leap!;
    this.creep.set(0, 0, 0);
    if (!this.grounded) {
      this.leap = null;
      this.state = 'free';
      return;
    }
    leap.t += dt;
    if (leap.down) {
      // Stop with her middle just short of the edge, front paws over it.
      const travelled = this.feet.sub(leap.from).setY(0).dot(leap.dir);
      const left = leap.edge - BRINK - travelled;
      if (left > 0.01) this.creep.copy(leap.dir).multiplyScalar(Math.min(0.5, left * 6));
    }
    if (leap.t < windupFor(leap)) return;

    // Planned again from where she ended up after getting ready.
    const feet = this.feet;
    const plan = this.planLeap(feet, leap);
    this.hv.copy(plan.hv);
    this.vy = plan.vy;
    this.grounded = false;
    leap.airborne = true;
    leap.scramble = plan.scramble;
    leap.from = feet;
    this.state = 'free';
  }

  // A leap too high to clear: once she's at the edge with its top in reach,
  // scramble up. The leap knows where the edge is, so this also works for
  // ledges the wall check in tryScramble can't see, like a shelf board with
  // open space under it.
  private leapScramble(): void {
    const leap = this.leap!;
    const center = toVec(this.body.translation());
    const travelled = center.clone().sub(leap.from).setY(0).dot(leap.dir);
    const toEdge = leap.edge - travelled;
    const below = leap.land.y - (center.y - CENTER_OFFSET);
    if (toEdge > tuning.catRadius + 0.1 || below > tuning.scrambleReach) return;
    this.startClimb(center, leap.land, leap.dir);
  }

  // Mid-air: if a ledge is in front and within reach, scramble up onto it.
  private tryScramble(dir: THREE.Vector3): void {
    const center = toVec(this.body.translation());
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

    this.startClimb(center, new THREE.Vector3(probe.x, ledgeY, probe.z), dir);
  }

  // Scramble from `center` up onto the point `onto` on top of a ledge.
  private startClimb(center: THREE.Vector3, onto: THREE.Vector3, dir: THREE.Vector3): void {
    const restY = onto.y + CENTER_OFFSET + 0.02;
    this.climb = {
      from: center,
      mid: new THREE.Vector3(center.x, restY, center.z),
      to: new THREE.Vector3(onto.x, restY, onto.z),
      t: 0,
    };
    this.state = 'climb';
    this.leap = null;
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
      this.arrive(c.to.y - CENTER_OFFSET);
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

    // The paw strikes along the cat's facing, not the camera.
    // Left paw kicks things a little to the right, and vice versa.
    const dir = facing
      .clone()
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

  // Where the held item sits, drawn back toward her as she winds up a throw.
  private holdPoint(): THREE.Vector3 {
    const facing = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const wind = smooth(this.charge() ?? 0);
    return this.feet
      .addScaledVector(UP, tuning.holdHeight - wind * tuning.throwWindDrop)
      .addScaledVector(facing, tuning.holdForward - wind * tuning.throwWindBack);
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

// How long she gets ready before a leap.
function windupFor(leap: Leap): number {
  return leap.down ? tuning.descendWindup : tuning.leapWindup;
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
