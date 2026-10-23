import * as THREE from 'three';
import { hullFromMesh, RAPIER } from './physics';

// A loose object the cat can knock over. Built from Blender custom properties
// (glTF extras) or from the grey-box room below.
export interface PropDef {
  name: string;
  // Detached copy of the prop with its world transform baked in.
  template: THREE.Object3D;
  mass: number;
  grabbable: boolean;
  fragile: boolean;
  // Pre-cut pieces in the prop's local space, or null to auto-generate.
  pieces: THREE.Object3D[] | null;
}

export interface Room {
  props: PropDef[];
  spawn: THREE.Vector3;
}

const COL_SUFFIX = /-col\d*$/i;
const PIECES_NAME = /^pieces/i;

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

// Reads a room scene that follows the conventions in docs/blender-guide.md:
// - meshes named `*-col` become invisible static colliders
// - objects with custom property `knockable` become physics props
//   (`grabbable`, `fragile`, `mass` are optional)
// - a child named `pieces` of a fragile prop holds its pre-cut pieces
// - meshes with `baked` use their texture as-is (unlit) and get a shadow overlay
// - an object named `spawn` marks where the cat starts
export function parseRoom(root: THREE.Object3D, world: InstanceType<typeof RAPIER.World>): Room {
  root.updateWorldMatrix(true, true);
  const props: PropDef[] = [];
  const colliders: THREE.Mesh[] = [];
  const baked: THREE.Mesh[] = [];
  const spawn = new THREE.Vector3(0, 0.3, 0);

  const originals: THREE.Object3D[] = [];

  const visit = (obj: THREE.Object3D) => {
    if (obj.name === 'spawn') obj.getWorldPosition(spawn);
    if (truthy(obj.userData.knockable)) {
      props.push(makePropDef(obj));
      originals.push(obj);
      return;
    }
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      if (COL_SUFFIX.test(mesh.name)) colliders.push(mesh);
      else if (truthy(mesh.userData.baked)) baked.push(mesh);
    }
    for (const child of obj.children) visit(child);
  };
  visit(root);

  // Props are owned by the prop system from here on.
  for (const obj of originals) obj.removeFromParent();

  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  for (const mesh of colliders) {
    const desc = hullFromMesh(mesh);
    if (desc) world.createCollider(desc.setFriction(0.8), body);
    else console.warn(`Collider mesh "${mesh.name}" has no volume`);
    mesh.visible = false;
  }

  for (const mesh of baked) applyBakedLook(mesh);

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && mesh.visible && !truthy(mesh.userData.baked)) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });

  return { props, spawn };
}

function makePropDef(obj: THREE.Object3D): PropDef {
  const template = obj.clone(true);
  obj.matrixWorld.decompose(template.position, template.quaternion, template.scale);

  let pieces: THREE.Object3D[] | null = null;
  const piecesNode = template.children.find((c) => PIECES_NAME.test(c.name));
  if (piecesNode) {
    // Bake the `pieces` node's transform so each piece is relative to the prop.
    piecesNode.updateMatrix();
    pieces = piecesNode.children.map((c) => {
      const piece = c.clone(true);
      piece.applyMatrix4(piecesNode.matrix);
      return piece;
    });
    piecesNode.removeFromParent();
  }

  template.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
  });

  const mass = Number(obj.userData.mass);
  return {
    name: obj.name,
    template,
    mass: Number.isFinite(mass) && mass > 0 ? mass : 0.5,
    grabbable: truthy(obj.userData.grabbable),
    fragile: truthy(obj.userData.fragile),
    pieces,
  };
}

// Baked lighting lives in the texture, so render it unlit, then lay a
// transparent shadow-only copy on top so the real-time shadow still shows.
function applyBakedLook(mesh: THREE.Mesh): void {
  const src = mesh.material as THREE.MeshStandardMaterial;
  mesh.material = new THREE.MeshBasicMaterial({ map: src.map ?? null, color: src.color });
  const catcher = new THREE.Mesh(mesh.geometry, new THREE.ShadowMaterial({ opacity: 0.35 }));
  catcher.receiveShadow = true;
  catcher.name = `${mesh.name}-shadow`;
  mesh.add(catcher);
}

// ---------------------------------------------------------------------------
// Grey-box room: a stand-in for the Blender room, built with the same
// conventions so parseRoom() handles both.

const palette = {
  floor: 0xc8a27a,
  wall: 0xf1e6d2,
  wood: 0x8a5a3b,
  darkWood: 0x5b3a29,
  fabric: 0x6f8fa6,
  counter: 0xe9e4dc,
  metal: 0xb8bcc2,
  ceramic: 0xf4f1ea,
  glass: 0xa8d8e8,
  red: 0xd9534f,
  yellow: 0xf2c14e,
  green: 0x5fa463,
  blue: 0x4a7fb5,
  black: 0x2b2b2b,
  paper: 0xfaf7ef,
};

type PropOpts = { mass: number; grabbable?: boolean; fragile?: boolean };

export function buildGreyboxRoom(): THREE.Group {
  const room = new THREE.Group();
  room.name = 'room';

  // A furniture block: visual mesh plus a matching `-col` collider.
  const block = (name: string, w: number, h: number, d: number, x: number, y: number, z: number, color: number) => {
    const geom = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
    mesh.name = name;
    mesh.position.set(x, y + h / 2, z);
    room.add(mesh);
    const col = new THREE.Mesh(geom);
    col.name = `${name}-col`;
    col.position.copy(mesh.position);
    room.add(col);
  };

  const prop = (name: string, shape: THREE.Object3D, x: number, surfaceY: number, z: number, opts: PropOpts, rotY = 0) => {
    const box = new THREE.Box3().setFromObject(shape);
    shape.name = name;
    shape.position.set(x, surfaceY - box.min.y + 0.001, z);
    shape.rotation.y = rotY;
    shape.userData = { knockable: true, ...opts };
    room.add(shape);
  };

  const mat = (color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...extra });
  const cyl = (r: number, h: number, color: number, extra?: Partial<THREE.MeshStandardMaterialParameters>) =>
    new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 16), mat(color, extra));
  const box = (w: number, h: number, d: number, color: number) =>
    new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  const ball = (r: number, color: number) => new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat(color));
  const glass = (r: number, h: number) => cyl(r, h, palette.glass, { transparent: true, opacity: 0.6, roughness: 0.1 });

  // Shell: floor and four walls (8 x 6 m, 2.6 m tall).
  block('floor', 8, 0.2, 6, 0, -0.2, 0, palette.floor);
  block('wall_n', 8.4, 2.6, 0.2, 0, 0, -3.1, palette.wall);
  block('wall_s', 8.4, 2.6, 0.2, 0, 0, 3.1, palette.wall);
  block('wall_w', 0.2, 2.6, 6, -4.1, 0, 0, palette.wall);
  block('wall_e', 0.2, 2.6, 6, 4.1, 0, 0, palette.wall);

  // Living room
  block('sofa_base', 2.0, 0.45, 0.85, -2.2, 0, -2.55, palette.fabric);
  block('sofa_back', 2.0, 0.4, 0.2, -2.2, 0.45, -2.88, palette.fabric);
  block('sofa_arm_l', 0.2, 0.15, 0.85, -3.1, 0.45, -2.55, palette.fabric);
  block('sofa_arm_r', 0.2, 0.15, 0.85, -1.3, 0.45, -2.55, palette.fabric);

  block('coffee_top', 1.1, 0.05, 0.6, -2.2, 0.4, -1.2, palette.wood);
  for (const [dx, dz] of [[-0.5, -0.25], [0.5, -0.25], [-0.5, 0.25], [0.5, 0.25]]) {
    block(`coffee_leg_${dx}_${dz}`, 0.05, 0.4, 0.05, -2.2 + dx, 0, -1.2 + dz, palette.darkWood);
  }

  block('side_table', 0.45, 0.6, 0.45, -3.6, 0, -2.6, palette.wood);
  block('tv_stand', 1.6, 0.5, 0.45, -2.2, 0, 2.75, palette.darkWood);

  block('desk', 0.6, 0.75, 1.2, -3.7, 0, 0.3, palette.wood);
  // Open bookshelf next to the desk: two sides, three boards, a top.
  const shelfX = -3.82;
  block('shelf_side_a', 0.35, 1.55, 0.03, shelfX, 0, 1.115, palette.darkWood);
  block('shelf_side_b', 0.35, 1.55, 0.03, shelfX, 0, 2.085, palette.darkWood);
  block('shelf_back', 0.03, 1.55, 1.0, -3.985, 0, 1.6, palette.darkWood);
  for (const y of [0, 0.5, 1.0]) block(`shelf_board_${y}`, 0.35, 0.03, 0.94, shelfX, y, 1.6, palette.darkWood);
  block('shelf_top', 0.35, 0.05, 1.0, shelfX, 1.55, 1.6, palette.darkWood);

  // Kitchen corner
  block('counter_e', 0.6, 0.9, 2.8, 3.7, 0, -1.6, palette.counter);
  block('counter_n', 1.8, 0.9, 0.6, 2.5, 0, -2.7, palette.counter);
  block('fridge', 0.7, 1.75, 0.7, 3.65, 0, 0.35, palette.metal);
  block('dining_table', 1.2, 0.75, 0.8, 1.8, 0, 1.4, palette.wood);
  block('chair_a_seat', 0.42, 0.45, 0.42, 1.8, 0, 0.7, palette.wood);
  block('chair_a_back', 0.42, 0.45, 0.04, 1.8, 0.45, 0.5, palette.wood);
  block('chair_b_seat', 0.42, 0.45, 0.42, 1.8, 0, 2.1, palette.wood);
  block('chair_b_back', 0.42, 0.45, 0.04, 1.8, 0.45, 2.3, palette.wood);

  const spawn = new THREE.Object3D();
  spawn.name = 'spawn';
  spawn.position.set(0, 0.3, 0);
  room.add(spawn);

  // --- Props ---
  const fragileSmall = (mass: number): PropOpts => ({ mass, grabbable: true, fragile: true });
  const small = (mass: number): PropOpts => ({ mass, grabbable: true });

  // Coffee table (top at 0.45)
  prop('mug_coffee_table', cyl(0.045, 0.1, palette.red), -2.45, 0.45, -1.3, fragileSmall(0.35));
  prop('remote', box(0.05, 0.02, 0.18, palette.black), -2.0, 0.45, -1.05, small(0.15), 0.4);
  prop('magazine', box(0.22, 0.01, 0.3, palette.blue), -1.9, 0.45, -1.3, small(0.2), -0.2);
  prop('glass_coffee_table', glass(0.035, 0.12), -2.6, 0.45, -1.05, fragileSmall(0.2));
  prop('fruit_bowl', cyl(0.11, 0.06, palette.ceramic), -2.25, 0.45, -1.15, fragileSmall(0.5));
  prop('apple', ball(0.04, palette.red), -2.25, 0.51, -1.15, small(0.15));
  prop('candle', cyl(0.04, 0.12, palette.yellow), -1.75, 0.45, -1.05, small(0.25));

  // Side table (top at 0.6)
  const lamp = new THREE.Group();
  const lampBase = cyl(0.08, 0.04, palette.darkWood);
  const lampStem = cyl(0.012, 0.35, palette.metal);
  lampStem.position.y = 0.2;
  const lampShade = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.14, 0.18, 16), mat(palette.paper));
  lampShade.position.y = 0.42;
  lamp.add(lampBase, lampStem, lampShade);
  prop('lamp', lamp, -3.6, 0.6, -2.65, { mass: 1.5 });
  prop('phone', box(0.07, 0.01, 0.15, palette.black), -3.5, 0.6, -2.45, small(0.18), 0.3);

  // TV stand (top at 0.5)
  prop('tv', box(1.0, 0.6, 0.06, palette.black), -2.2, 0.5, 2.85, { mass: 6, fragile: true });
  prop('game_controller', box(0.15, 0.05, 0.1, palette.black), -1.55, 0.5, 2.65, small(0.2));
  const plant = new THREE.Group();
  const pot = cyl(0.07, 0.14, 0xc0673f);
  const leaves = ball(0.1, palette.green);
  leaves.position.y = 0.13;
  plant.add(pot, leaves);
  prop('plant_pot', plant, -2.85, 0.5, 2.7, fragileSmall(0.6));
  prop('picture_frame', box(0.15, 0.2, 0.02, palette.wood), -1.5, 0.5, 2.85, fragileSmall(0.3));

  // Desk (top at 0.75)
  prop('pencil_cup', cyl(0.04, 0.1, palette.blue), -3.85, 0.75, -0.15, small(0.2));
  prop('laptop', box(0.32, 0.02, 0.22, palette.metal), -3.7, 0.75, 0.25, { mass: 1.4 }, Math.PI / 2);
  prop('mug_desk', cyl(0.045, 0.1, palette.yellow), -3.55, 0.75, 0.7, fragileSmall(0.35));
  prop('papers', box(0.21, 0.02, 0.3, palette.paper), -3.6, 0.75, -0.1, small(0.2), 0.15);
  prop('glass_desk', glass(0.035, 0.12), -3.5, 0.75, 0.5, fragileSmall(0.2));

  // Bookshelf boards (tops at 0.03, 0.53, 1.03) and top (1.6)
  const bookColors = [palette.red, palette.blue, palette.green, palette.yellow, palette.darkWood, palette.fabric];
  bookColors.forEach((c, i) => {
    const boardY = i < 3 ? 0.53 : 1.03;
    const z = 1.3 + (i % 3) * 0.06;
    prop(`book_${i}`, box(0.17, 0.24, 0.04, c), shelfX, boardY, z, small(0.5));
  });
  prop('vase_shelf', cyl(0.07, 0.25, palette.blue), shelfX, 1.6, 1.8, { mass: 1, fragile: true });
  prop('figurine', cyl(0.03, 0.12, palette.yellow), shelfX, 1.03, 1.9, fragileSmall(0.2));

  // East counter (top at 0.9)
  [0, 1, 2].forEach((i) =>
    prop(`plate_${i}`, cyl(0.11, 0.015, palette.ceramic), 3.7, 0.9 + i * 0.017, -2.2, fragileSmall(0.4)),
  );
  prop('wine_glass', glass(0.03, 0.18), 3.6, 0.9, -1.85, fragileSmall(0.2));
  prop('bottle', cyl(0.04, 0.28, palette.green, { roughness: 0.2 }), 3.8, 0.9, -1.6, { mass: 0.8, fragile: true });
  prop('toaster', box(0.27, 0.2, 0.16, palette.metal), 3.75, 0.9, -1.15, { mass: 1.5 }, Math.PI / 2);
  prop('cereal_box', box(0.19, 0.28, 0.07, palette.yellow), 3.85, 0.9, -0.7, small(0.4), Math.PI / 2);
  prop('salt_shaker', cyl(0.02, 0.08, palette.ceramic), 3.55, 0.9, -0.45, fragileSmall(0.1));
  const egg = () => {
    const e = ball(0.025, palette.paper);
    e.scale.set(1, 1.3, 1);
    return e;
  };
  prop('egg_0', egg(), 3.55, 0.9, -1.4, fragileSmall(0.06));
  prop('egg_1', egg(), 3.6, 0.9, -1.35, fragileSmall(0.06));

  // North counter (top at 0.9)
  prop('jar', cyl(0.06, 0.15, palette.glass, { transparent: true, opacity: 0.7 }), 1.9, 0.9, -2.7, fragileSmall(0.5));
  prop('mug_kitchen', cyl(0.045, 0.1, palette.blue), 2.3, 0.9, -2.6, fragileSmall(0.35));
  prop('cutting_board', box(0.3, 0.02, 0.2, palette.wood), 2.8, 0.9, -2.7, small(0.6));

  // Fridge top (1.75)
  prop('cookie_jar', cyl(0.08, 0.16, palette.ceramic), 3.5, 1.75, 0.2, { mass: 0.8, fragile: true });
  prop('cardboard_box', box(0.3, 0.2, 0.25, 0xb08b5a), 3.75, 1.75, 0.5, { mass: 0.3 });

  // Dining table (top at 0.75)
  const flowers = new THREE.Group();
  const flowerVase = cyl(0.05, 0.18, palette.glass, { transparent: true, opacity: 0.7 });
  const bloom = ball(0.07, 0xe67fb0);
  bloom.position.y = 0.15;
  flowers.add(flowerVase, bloom);
  prop('flower_vase', flowers, 1.8, 0.75, 1.4, fragileSmall(0.6));
  prop('glass_dining_a', glass(0.035, 0.12), 1.45, 0.75, 1.2, fragileSmall(0.2));
  prop('glass_dining_b', glass(0.035, 0.12), 2.15, 0.75, 1.6, fragileSmall(0.2));
  prop('plate_dining', cyl(0.11, 0.015, palette.ceramic), 1.5, 0.75, 1.6, fragileSmall(0.4));
  prop('napkin_holder', box(0.12, 0.08, 0.05, palette.metal), 2.05, 0.75, 1.15, small(0.2));

  return room;
}
