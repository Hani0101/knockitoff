import * as THREE from 'three';
import { tuning } from '../config';
import { RAPIER, STATIC_ONLY } from './physics';

type World = InstanceType<typeof RAPIER.World>;

// Third-person camera orbiting the cat, pulled in when a wall is in the way.
export class CameraRig {
  yaw = 0;
  pitch = 0.35;
  private distance = tuning.cameraDistance;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private world: World,
  ) {}

  look(dx: number, dy: number, sensitivity: number, invertY: boolean): void {
    const s = tuning.mouseSensitivity * sensitivity;
    this.yaw -= dx * s;
    this.pitch += dy * s * (invertY ? -1 : 1);
    this.pitch = THREE.MathUtils.clamp(this.pitch, tuning.cameraMinPitch, tuning.cameraMaxPitch);
  }

  // Horizontal forward direction (where W walks).
  forwardFlat(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  // Full aim direction, including pitch (where throws go).
  aim(out = new THREE.Vector3()): THREE.Vector3 {
    return this.camera.getWorldDirection(out);
  }

  update(target: THREE.Vector3, dt: number): void {
    const pivot = target.clone();
    pivot.y += tuning.cameraHeight;
    const back = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    );

    let wanted = tuning.cameraDistance;
    const hit = this.world.castRay(new RAPIER.Ray(pivot, back), wanted, true, STATIC_ONLY);
    if (hit) wanted = Math.max(0.3, hit.timeOfImpact - 0.15);
    // Snap in quickly when blocked, ease back out.
    const rate = wanted < this.distance ? 30 : 4;
    this.distance += (wanted - this.distance) * Math.min(1, rate * dt);

    this.camera.position.copy(pivot).addScaledVector(back, this.distance);
    this.camera.lookAt(pivot);
  }
}
