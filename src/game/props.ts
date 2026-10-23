import * as THREE from 'three';
import { tuning } from '../config';
import type { GameAudio } from './audio';
import { collectPoints, propColliders, RAPIER, unscaledWorldMatrix } from './physics';
import type { PropDef } from './room';

type World = InstanceType<typeof RAPIER.World>;
type RigidBody = InstanceType<typeof RAPIER.RigidBody>;

export interface Prop {
  def: PropDef;
  object: THREE.Object3D;
  body: RigidBody;
  held: boolean;
  broken: boolean;
  // Velocity from the previous step, i.e. just before any impact.
  lastVel: THREE.Vector3;
}

interface Debris {
  object: THREE.Object3D;
  body: RigidBody;
}

const EVENTS = RAPIER.ActiveEvents.COLLISION_EVENTS;
// Props slower than this (m/s) count as resting, e.g. for the cat to look at.
const RESTING_SPEED = 0.5;

export class PropSystem {
  props: Prop[] = [];
  private debris: Debris[] = [];
  private byCollider = new Map<number, Prop>();
  private hullCache = new Map<PropDef, Float32Array>();
  private lastSoundAt = 0;

  constructor(
    private scene: THREE.Scene,
    private world: World,
    private defs: PropDef[],
    private audio: GameAudio,
  ) {
    this.spawnAll();
  }

  reset(): void {
    for (const p of this.props) this.removeProp(p);
    for (const d of this.debris) this.removeDebris(d);
    this.props = [];
    this.debris = [];
    this.byCollider.clear();
    this.spawnAll();
  }

  // Copies physics transforms onto meshes. Call once per physics step,
  // before stepping, so `lastVel` holds pre-impact velocity.
  sync(): void {
    for (const p of this.props) {
      const t = p.body.translation();
      const r = p.body.rotation();
      p.object.position.set(t.x, t.y, t.z);
      p.object.quaternion.set(r.x, r.y, r.z, r.w);
      const v = p.body.linvel();
      p.lastVel.set(v.x, v.y, v.z);
    }
    for (const d of this.debris) {
      if (d.body.isSleeping()) continue;
      const t = d.body.translation();
      const r = d.body.rotation();
      d.object.position.set(t.x, t.y, t.z);
      d.object.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  // Handles a "collision started" event from the physics step.
  onCollision(h1: number, h2: number, catHandle: number): void {
    for (const [mine, other] of [[h1, h2], [h2, h1]]) {
      const p = this.byCollider.get(mine);
      if (!p || p.broken || p.held || other === catHandle) continue;
      const speed = p.lastVel.length();
      const vy = Math.abs(p.lastVel.y);
      if (speed > 1.2) this.playImpact(speed, p.def.mass);
      // Falls and hard throws break things; sliding along a table doesn't.
      const hardHit = vy > tuning.breakSpeed * 0.8 || speed > tuning.breakSpeed * 1.6;
      if (p.def.fragile && hardHit) this.shatter(p);
    }
  }

  propForCollider(handle: number): Prop | undefined {
    return this.byCollider.get(handle);
  }

  // Nearest intact prop to `pos` within `maxDist`, optionally only in front of
  // `forward`, only grabbable ones, or only ones that are (nearly) at rest.
  nearest(
    pos: THREE.Vector3,
    maxDist: number,
    opts: { forward?: THREE.Vector3; grabbable?: boolean; resting?: boolean } = {},
  ): Prop | null {
    let best: Prop | null = null;
    let bestDist = maxDist;
    const to = new THREE.Vector3();
    for (const p of this.props) {
      if (p.broken || p.held) continue;
      if (opts.grabbable && !p.def.grabbable) continue;
      if (opts.resting && p.lastVel.lengthSq() > RESTING_SPEED * RESTING_SPEED) continue;
      to.subVectors(p.object.position, pos);
      const dist = to.length();
      if (dist > bestDist) continue;
      if (opts.forward && to.dot(opts.forward) < 0) continue;
      best = p;
      bestDist = dist;
    }
    return best;
  }

  setHeld(p: Prop, held: boolean): void {
    p.held = held;
    p.body.setBodyType(
      held ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic,
      true,
    );
  }

  shatter(p: Prop): void {
    p.broken = true;
    const vel = p.lastVel.clone();
    p.object.updateMatrixWorld(true);
    const center = p.object.position.clone();
    const pieces = this.makePieces(p);

    for (const piece of pieces) {
      this.scene.add(piece);
      const frame = unscaledWorldMatrix(piece);
      const points = collectPoints(piece, frame);
      const desc = (RAPIER.ColliderDesc.convexHull(points) ?? RAPIER.ColliderDesc.ball(0.01))
        .setMass(Math.max(p.def.mass / pieces.length, 0.01))
        .setFriction(0.7)
        .setRestitution(0.2);
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      frame.decompose(pos, quat, new THREE.Vector3());
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(pos.x, pos.y, pos.z)
          .setRotation(quat)
          .setLinearDamping(0.3)
          .setAngularDamping(0.5),
      );
      this.world.createCollider(desc, body);
      const out = pos.clone().sub(center).normalize().multiplyScalar(1.2 + Math.random());
      body.setLinvel({ x: vel.x * 0.4 + out.x, y: Math.abs(vel.y) * 0.25 + 0.8 + out.y * 0.5, z: vel.z * 0.4 + out.z }, true);
      body.setAngvel({ x: rand(8), y: rand(8), z: rand(8) }, true);
      this.debris.push({ object: piece, body });
    }

    while (this.debris.length > tuning.maxDebris) this.removeDebris(this.debris.shift()!);

    this.removeProp(p);
    this.props = this.props.filter((x) => x !== p);
    this.audio.shatter(Math.min(1, p.def.mass));
  }

  private spawnAll(): void {
    for (const def of this.defs) this.spawn(def);
  }

  private spawn(def: PropDef): void {
    const object = def.template.clone(true);
    this.scene.add(object);

    let points = this.hullCache.get(def);
    if (!points) {
      points = collectPoints(object, unscaledWorldMatrix(object));
      this.hullCache.set(def, points);
    }
    const q = object.quaternion;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(object.position.x, object.position.y, object.position.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setLinearDamping(0.1)
        .setAngularDamping(0.3)
        .setCcdEnabled(true),
    );
    const prop: Prop = { def, object, body, held: false, broken: false, lastVel: new THREE.Vector3() };
    for (const { desc, share } of propColliders(points)) {
      desc.setMass(def.mass * share).setFriction(0.6).setRestitution(0.3).setActiveEvents(EVENTS);
      this.byCollider.set(this.world.createCollider(desc, body).handle, prop);
    }
    this.props.push(prop);
  }

  private removeProp(p: Prop): void {
    for (let i = 0; i < p.body.numColliders(); i++) this.byCollider.delete(p.body.collider(i).handle);
    this.world.removeRigidBody(p.body);
    p.object.removeFromParent();
  }

  private removeDebris(d: Debris): void {
    this.world.removeRigidBody(d.body);
    d.object.removeFromParent();
  }

  // World-space piece objects for a breaking prop: pre-cut pieces from
  // Blender if present, otherwise box chunks cut from its bounding box.
  private makePieces(p: Prop): THREE.Object3D[] {
    const world = p.object.matrixWorld;
    if (p.def.pieces?.length) {
      return p.def.pieces.map((src) => {
        const piece = src.clone(true);
        const m = new THREE.Matrix4().multiplyMatrices(world, src.matrix);
        m.decompose(piece.position, piece.quaternion, piece.scale);
        return piece;
      });
    }

    const frame = unscaledWorldMatrix(p.object);
    const points = this.hullCache.get(p.def)!;
    const box = new THREE.Box3().setFromArray(points);
    const size = box.getSize(new THREE.Vector3());
    const splits = [size.x, size.y, size.z].map((s) => (s < 0.04 ? 1 : s > 0.2 ? 3 : 2));
    const cell = new THREE.Vector3(size.x / splits[0], size.y / splits[1], size.z / splits[2]);
    const material = firstMaterial(p.object);
    const pieces: THREE.Object3D[] = [];

    for (let i = 0; i < splits[0]; i++) {
      for (let j = 0; j < splits[1]; j++) {
        for (let k = 0; k < splits[2]; k++) {
          const geom = new THREE.BoxGeometry(cell.x * 0.85, cell.y * 0.85, cell.z * 0.85);
          const piece = new THREE.Mesh(geom, material);
          piece.castShadow = true;
          const local = new THREE.Vector3(
            box.min.x + cell.x * (i + 0.5),
            box.min.y + cell.y * (j + 0.5),
            box.min.z + cell.z * (k + 0.5),
          );
          const m = new THREE.Matrix4().multiplyMatrices(frame, new THREE.Matrix4().makeTranslation(local));
          m.decompose(piece.position, piece.quaternion, piece.scale);
          pieces.push(piece);
        }
      }
    }
    return pieces;
  }

  private playImpact(speed: number, mass: number): void {
    const now = performance.now();
    if (now - this.lastSoundAt < 40) return;
    this.lastSoundAt = now;
    this.audio.impact(Math.min(1, (speed / 6) * (0.5 + Math.min(mass, 3) / 6)));
  }
}

function rand(amount: number): number {
  return (Math.random() - 0.5) * 2 * amount;
}

function firstMaterial(root: THREE.Object3D): THREE.Material {
  let found: THREE.Material | null = null;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!found && mesh.isMesh) found = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  });
  return found ?? new THREE.MeshStandardMaterial({ color: 0xffffff });
}
