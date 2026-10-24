# Blender guide

How to get the cat and the room from Blender into Knock It Off. The game reads
object names and custom properties directly from the export, so these
conventions are what make things work, not just tidiness.

## Pipeline

1. **Export from Blender** as **glTF Binary (.glb)** into `assets-src/` as
   `cat.glb` or `room.glb`.
   - Format: glTF Binary, **+Y Up** on
   - Include: **Custom Properties** on. Leave "Visible Objects" off so hidden
     pieces still export.
   - Transform: Apply Modifiers on
   - Armature (cat only): **Export Deformation Bones Only** on
   - Animation (cat only): mode **Actions**, export all actions
2. **Run `npm run compress`.** It writes compressed copies to `public/models/`
   and prints triangle counts and file sizes against the budget. Textures
   become KTX2 if [KTX-Software](https://github.com/KhronosGroup/KTX-Software/releases)
   (`toktx`) is installed, otherwise WebP.
3. **Point the game at the files** in `src/config.ts`: set
   `cat: 'models/cat.glb'` and `room: 'models/room.glb'`. While a path is
   `null`, the grey-box stand-in is used instead.
4. **Credit the authors.** Add every CC-BY author to `src/credits.ts`.

General rules:

- Units are meters (1 Blender unit = 1 m).
- **Apply scale** (Ctrl+A → Scale) on every mesh and armature before exporting.
- Use Principled BSDF materials only. Custom node setups don't survive glTF
  export.

## Budget

| What           | Limit                                                 |
| -------------- | ----------------------------------------------------- |
| Cat            | 20k triangles (8–15k is plenty)                       |
| Whole room     | 200k triangles                                        |
| A single prop  | about 2k triangles; its collision shape is built from its vertices |
| Textures       | 2048 px max; 1024 px or less for props                |
| Total download | about 30 MB. The game code takes about 2 MB, so roughly 25 MB is left for models, textures and sounds. |

## The cat

### Size and orientation

- **Size:** about 0.45 m from nose to tail base. The top of the head is about
  0.3 m off the ground.
- **Physics body:** a capsule 0.3 m wide and 0.38 m tall. The mesh can stick
  out a little at the nose and tail.
- **Origin** at the feet, centered between the paws.
- **Facing:** the cat looks along Blender's **+Y** axis, which is away from you
  in Front view. If it ends up backwards in the game, set
  `catModel.yawOffset = Math.PI` in `src/config.ts`.

### Rig

- Use Rigify's cat metarig: Add → Armature → Animals → Cat.
- Export deform bones only.
- At most 4 bone influences per vertex. three.js can't use more.
- **Head and tail bones:** put their names in `catModel.headBone` and
  `catModel.tailBones` (`src/config.ts`). The current values are guesses.
  Check the real names after generating the rig.
- **Keep the head and tail fairly still in the animations.** The game turns the
  head toward nearby objects and sways the tail on top of whatever the clip
  does.

### Animations

- **Animate in place.** The game moves the cat, so don't use root motion.
- **Bake the actions.** Constraints and IK don't export, but the exporter
  samples the result, so baked IK animation is fine.
- **One action per name**, using exactly the names below (case-sensitive). A
  missing one falls back to `idle` and prints a console warning.

| Name      | Loop | Notes |
| --------- | ---- | ----- |
| `idle`    | yes  | Standing, breathing |
| `walk`    | yes  | Animated for about 0.8 m/s (`catModel.walkClipSpeed`); the game speeds it up to match |
| `run`     | yes  | Animated for about 2.6 m/s (`catModel.runClipSpeed`); the game speeds it up to match |
| `pounce`  | yes  | Crouched, eyes on a ledge, rear wiggling; held until she leaps onto it |
| `jump`    | no   | Takeoff into an airborne pose; hold the last frame. Frame 3 (at 24 fps) is the crouch a leap starts from |
| `land`    | no   | Short, about 0.12 s |
| `descend` | no   | Getting down: reach over the edge (frames 0–8 at 24 fps, matching `tuning.descendWindup`), push off, then drop front paws first; hold the last frame |
| `climb`   | no   | Ledge scramble, 0.5 s: front paws on the ledge, then pull up |
| `swipe_L` | no   | Left paw swipe, about 0.3 s; the paw lands at about 0.08 s |
| `swipe_R` | no   | Right paw swipe, same timing |
| `grab`    | no   | Sit up on the hind legs and take the item, about 0.25 s |
| `hold`    | yes  | Sitting up, holding the item in both front paws in front of the chest |
| `throw`   | no   | Both paws push forward, about 0.3 s |
| `trick`   | no   | Toss the item straight up, then get ready to spike |

The held item floats 0.32 m up and 0.2 m in front of the feet
(`tuning.holdHeight` and `holdForward` in `src/config.ts`). Pose the paws
around that point.

### Placeholder versus final cat

| | Low Poly Cat (placeholder) | Empire's cat (final) |
| --- | --- | --- |
| Triangles | 732 | 70.6k (must come down to 20k or fewer) |
| Work needed | Rig and rough out all 12 animations | Retopologize, bake normal and color maps from the sculpt, rig, animate |
| Purpose | Lets gameplay be tuned with real animations early | Ships in the game |

Both models must use the same animation names. Then swapping one for the
other only means changing the file.

### Files and scripts

The placeholder cat lives in `blender/cat_placeholder.blend`. It has two
armatures:

- `rig`: the Rigify rig you animate with. Its actions are named
  `<name>__ctrl` and are not exported.
- `cat_rig`: the export skeleton. It holds only the 29 `DEF-*` bones, and the
  mesh is skinned to it. Each bone follows `rig` through a `follow_rig`
  constraint, and each animation is baked onto it under its game name.

The scripts in `blender/` run inside Blender (Text Editor → Run Script):

| Script | What it does |
| --- | --- |
| `cat_rig_build.py` | Rebuilds `cat_rig` from the generated Rigify rig and re-skins the mesh (4 influences, no seams). Run it after regenerating the rig. |
| `cat_anims.py` | Keys all 12 animations on `rig` and bakes them onto `cat_rig`. Edit the poses there and re-run, or hand-edit a `*__ctrl` action and re-bake just that one with `bake("walk")`. |
| `export_cat.py` | Checks scale, weights, materials and animation names, then exports `assets-src/cat.glb` with the settings above. |

In this rig the cat's left is -X, so `.L` bones are on the cat's left side.
The head bone is `DEF-spine.006` and the tail runs `DEF-tail.001` (base) to
`DEF-tail.004` (tip). The game strips the `.` from bone names when loading
(`DEF-spine006`), but `config.ts` takes the Blender names.

## The room

Build the whole room in one Blender scene.

### What each kind of object becomes

| In Blender | In the game |
| --- | --- |
| Ordinary mesh | Drawn, but not solid |
| Mesh named `*-col` (e.g. `sofa-col`, `sofa-col.001`) | Invisible solid collider. **It must be convex**, so build furniture from a few boxes. Floor and walls need colliders too. |
| Object with custom property `knockable` | Physics prop (see below) |
| Child empty named `pieces` under a fragile prop | Its pre-cut pieces. They're hidden until the prop breaks. |
| Empty named `spawn` | Where the cat starts |
| Mesh with custom property `baked` | Drawn unlit using its baked texture, with a shadow overlay on top |

### Props

Props are marked with **object** custom properties. These go in Object
Properties → Custom Properties, not on the mesh data.

| Property | Type | Meaning |
| --- | --- | --- |
| `knockable` | bool | Makes it a physics object (required) |
| `grabbable` | bool | The cat can pick it up. Use it only for small, light items: under about 20 cm and 0.6 kg or less. |
| `fragile` | bool | It breaks on a hard landing |
| `mass` | float (kg) | Defaults to 0.5. Mug ~0.35, book ~0.5, vase ~1, lamp ~1.5, TV ~6. |

- A prop can be an empty with several child meshes. Its physics shape is
  **one convex hull around all of them**. A bowl is therefore solid, nothing
  can sit inside it, and a lamp's shade and stem act as one blob.
- **Pre-cut pieces:** use the Cell Fracture add-on. Put the pieces under a
  `pieces` empty, in the same place as the intact object. 5–12 pieces per prop
  is plenty. Each piece is convex automatically.
- Place props resting on their surface, not floating or sunk into it.

### Sizes and heights

The cat jumps 0.8 m. In mid-air it can also scramble onto a ledge up to
0.55 m above its feet, so from the floor it reaches about 1.35 m. Higher
surfaces need a step up to them.

| Surface | Grey-box height | Reached from |
| --- | --- | --- |
| Chair seat | 0.45 m | floor (jump) |
| Coffee table | 0.45 m | floor (jump) |
| TV stand | 0.5 m | floor (jump) |
| Side table | 0.6 m | floor (jump) |
| Desk / dining table | 0.75 m | floor (jump) |
| Kitchen counter | 0.9 m | floor (jump + scramble) |
| Bookshelf top | 1.6 m | desk (jump + scramble) |
| Fridge top | 1.75 m | counter (jump + scramble) |

- **Standing room:** a surface must be at least 0.3 m deep for the cat to
  stand on it.
- **Headroom:** the cat needs at least 0.4 m of headroom to walk under things.
  The coffee table's underside is at 0.4 m.
- **Shelves:** leave gaps of 0.45 m or more between shelves if the cat should
  fit inside.
- **Room size:** about 8 × 6 m with 2.6 m walls. Bigger is fine, but every
  extra prop costs physics time. 40–80 props is comfortable.

### Baked lighting

- Bake lighting into the base color texture with Cycles, bake type
  **Combined**. Mark those meshes `baked`.
- Each baked mesh needs its own non-overlapping UVs.
- **Hide all props while baking.** Anything baked in stays painted on, and a
  mug's baked shadow would remain on the table after the mug is knocked off.
- Never mark props `baked`. They move, so they use real-time lighting.
- Baked textures take up most of the download. A few 2K atlases for the whole
  room is a good target.

### Files and scripts

The room lives in `blender/room.blend` and is generated by scripts in
`blender/`, so layout changes are made in code and rebuilt:

| Script | What it does |
| --- | --- |
| `room_build.py` | Builds everything: shell, furniture, colliders, bake lights, the `spawn` empty, and the 50 props with their custom properties and pre-cut pieces. Re-running replaces what it built. |
| `room_lib.py` | Helpers it uses: mesh builders, materials, colliders and the Voronoi fracture that makes the pieces (the same method as the Cell Fracture add-on, which Blender 5 no longer bundles). |
| `room_bake.py` | `prepare()` unwraps each static mesh into one of four 2048 px atlases (`floor`, `walls`, `living`, `kitchen`, set by the object's `bake_group` property) and marks it `baked`. Run the bake itself in the background: `blender -b blender/room.blend --python blender/room_bake.py -- --samples 64`. It hides props, colliders and pieces, bakes Combined (diffuse and emission), denoises and writes `blender/bake/*.png`. `apply()` then makes one atlas material per group. |
| `export_room.py` | Checks budgets and conventions, then exports `assets-src/room.glb` with the atlas materials swapped in. |

After changing the layout: run `room_build.py`, then `room_bake.prepare()`,
save, bake in the background, run `room_bake.apply()` and `export_room.py`,
then `npm run compress`.

## Sounds

- **Sound effects** are made in code for now (`src/game/audio.ts`).
- **Music** plays if `assets.sounds.music` in `src/config.ts` points to a
  file in `public/`.
- CC0 sounds only.
