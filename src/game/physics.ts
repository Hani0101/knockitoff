import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

export { RAPIER };

let ready: Promise<void> | null = null;

export function initPhysics(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}

export function toVec(v: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z);
}

// Ray and shape queries that only hit the static room.
export const STATIC_ONLY =
  RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC;
// Queries that only hit loose objects.
export const DYNAMIC_ONLY =
  RAPIER.QueryFilterFlags.EXCLUDE_FIXED | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC;

// Collects all mesh vertices under `root` into the local frame of `frame`
// (position and rotation only; scale is baked into the points).
export function collectPoints(
  root: THREE.Object3D,
  frame: THREE.Matrix4,
  skip?: (obj: THREE.Object3D) => boolean,
): Float32Array {
  const inv = frame.clone().invert();
  const out: number[] = [];
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  root.updateWorldMatrix(true, true);
  const visit = (obj: THREE.Object3D) => {
    if (skip?.(obj)) return;
    if ((obj as THREE.Mesh).isMesh) {
      const pos = (obj as THREE.Mesh).geometry.getAttribute('position');
      m.multiplyMatrices(inv, obj.matrixWorld);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        out.push(v.x, v.y, v.z);
      }
    }
    for (const child of obj.children) visit(child);
  };
  visit(root);
  return new Float32Array(out);
}

// Builds a static convex-hull collider description from a mesh in world space.
// Hulls are solid, so thin props can't sink through them like they can with
// triangle meshes; concave furniture is split into several `-col` meshes.
export function hullFromMesh(mesh: THREE.Mesh): InstanceType<typeof RAPIER.ColliderDesc> | null {
  return RAPIER.ColliderDesc.convexHull(collectPoints(mesh, new THREE.Matrix4()));
}

// World transform of an object without its scale.
export function unscaledWorldMatrix(obj: THREE.Object3D): THREE.Matrix4 {
  obj.updateWorldMatrix(true, false);
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  obj.matrixWorld.decompose(p, q, s);
  return new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1));
}
