# Knock It Off: game design

This is the spec agreed on 2026-10-23. The point of the game is to knock
things off surfaces. If you want to change a decision here, update this file
too.

## Concept

You play a cat in one room. Everything on every surface is there to be
knocked off. The game is meant to be simple and silly:

- No levels and no big world.
- No server.
- Desktop only.

## Game mode

- **Pure sandbox.** No score, no timer, no win or lose state.
- **No progress counter.** We rejected a "things knocked off: 17/40" counter
  on purpose.
- **R resets the room.** All objects go back where they started and all debris
  is cleared.
- **No humans.** No owner chases or catches the cat.

## The cat

- She has no name and is called "the cat", or "she".
- **Camera:** third-person. It follows behind her, you turn it with the mouse,
  and it pulls in when a wall is in the way.

### Controls

| Input | Action |
| --- | --- |
| WASD or arrow keys | Move |
| Shift | Run |
| Space | Jump (fixed height) |
| Mouse | Look |
| Left click | Left paw swipe |
| Right click | Right paw swipe |
| Both buttons together, or one held while pressing the other | Two-paw grab |
| Click while holding | Throw. Hold the button longer for more power. |
| F while holding | Trick |
| M | Meow |
| R | Reset the room |
| Esc | Pause |

### Movement

- **Jump:** the feet rise 0.8 m, which is enough to land on a table.
- **Climbing:** if a ledge is within reach in mid-air (up to 0.55 m above the
  feet), the cat scrambles onto it automatically. A climbing animation plays.
- **No climbing walls or curtains.** Climbing is ledge scrambles only.

### Knocking things over

- **Walking into things** gives them a small push.
- **Swiping:** pushes things mostly where the camera is aiming, with a small
  sideways kick away from the paw that swiped. So a left-paw swipe nudges
  things slightly to the right.
- **Grabbing:** only small, light items marked `grabbable` can be grabbed.
  - The cat sits up on her hind legs holding the item.
  - She can't walk, but she can turn to aim.
  - A click throws the item where the camera is aiming.
  - If there's nothing to grab, she slaps with both paws instead.
- **Trick (v1 has one):** "bat it up and spike it".
  1. F tosses the item straight up.
  2. A "SPIKE!" prompt shows during a short window around the top of the toss.
  3. Clicking inside the window spikes the item forward.
  4. Clicking outside it misses, and the item just drops.

  More tricks can come later. Each one needs its own animation and tuning.

### Animation

- Skeleton animation is made in Blender and played back by name in the game.
- These are done in code on top of the Blender animation:
  - The head turns toward the nearest item.
  - The tail sways faster when she moves faster.
- No paw IK: the paw doesn't bend in code to reach the item. A swipe plays its
  animation and pushes whatever is in the paw's hit zone.

## Physics feel

- **Exaggerated cartoon physics:** objects are light, swipes hit hard, and
  things bounce and spin a bit.
- **Breaking:** fragile items shatter on a hard landing: a fall from a table,
  or a hard throw into something. Sliding along a table doesn't break them.
- **Pieces:** they're cut in Blender ahead of time. If a fragile item has no
  pieces, the game cuts it into box chunks.
- **Debris:** stays on the floor until you reset. It stops moving once it
  settles, and only the newest 300 pieces are kept.

## The room

One room: a living room with a small kitchen corner, about 8 × 6 m with walls
2.6 m tall, and about 40–50 knockable objects.

- **Living room:** sofa, coffee table, side table with a lamp, TV stand with a
  TV, desk, bookshelf.
- **Kitchen:** an L-shaped counter, a fridge, a dining table and two chairs.

Lay out the surfaces so they can be climbed in steps:

- Floor → chair → table.
- Desk → bookshelf top.
- Counter → fridge top.

The [Blender guide](blender-guide.md) has the exact heights.

## Art

- **Style:** semi-cartoony. It doesn't have to be low-poly, as long as it
  stays within the budget below.
- **Placeholder cat while developing:**
  [Low Poly Cat](https://sketchfab.com/3d-models/low-poly-cat-1e7143dfafd04ff4891efcb06949a0b4)
  by volkanongun (CC BY 4.0, 732 triangles). It gets a quick rig and rough
  animations.
- **Final cat:**
  [Cat 3D Model](https://sketchfab.com/3d-models/cat-3d-model-free-0db8c53b5b3d474b8a7c90e2350994f6)
  by Empire (CC BY 4.0, 70.6k triangles). It gets retopologized to 20k
  triangles or fewer, rigged with Rigify and animated by you. It drops in under
  the same animation names.
- **Rejected:** the original
  [Cat in motion](https://sketchfab.com/3d-models/cat-in-motion-3d-model-free-baa1120483c844e6bce9744f3f868c63)
  model. It's AI-generated, 389.6k triangles, and the page doesn't say it's
  rigged or animated.
- **Furniture and props:** free CC0 packs (Kenney, Quaternius, Poly Pizza),
  recoloured with one shared palette. You model a few hero items yourself.
- **Lighting:** baked in Blender, plus one real-time light that casts shadows
  from the cat and moving objects.

### Budget

| What | Limit |
| --- | --- |
| Cat | 20k triangles |
| Whole room | 200k triangles |
| Textures | 2048 px max, compressed |
| Total download | under about 30 MB |

## Audio

- **Sound effects:** thuds, shatters, paw swipes and a meow, all from CC0
  sources (Freesound, Kenney).
- **Music:** a quiet background loop, also CC0.
- **For now:** sound effects are made in code as placeholders. Music plays
  once a file is set up.

## Screens

- **Phones:** touch-only devices get a "Desktop only" page with no "play
  anyway" button. Tablets with a mouse can play.
- **Loading screen:** a progress bar plus joke lines that change every
  2 seconds in random order. It shows for at least 3 seconds. The lines:
  - "The cat is doing catnip..."
  - "The cat is robbing a bank, wait until she's back..."
  - "The cat is smuggling treats across the border..." (reworded from
    "trafficking" so it can't be misread)
  - "The cat is listening to Wadih El Sheikh and drifting in Zahle..."
  - "The cat is doing flips..."
- **Title screen:** Play, Controls, Credits.
- **Pause (Esc):** Resume, Quit to title, plus settings: mouse sensitivity,
  invert Y, volume. Settings are saved in the browser (localStorage).
- **HUD:** a crosshair dot, a throw power bar and the "SPIKE!" prompt.
- **Language:** English only. All text lives in `src/strings.ts` so Arabic can
  be added later.

## Tech

- **Stack:** TypeScript, Vite, Three.js (WebGL2) and Rapier physics.
- **Browsers:** current desktop Chrome, Edge, Firefox and Safari. No WebGPU,
  and no support for old browsers.
- **Loading:** everything loads before the title screen, with no streaming
  during play.
- **Hosting:** a static site with no server.
- **Asset compression:** `npm run compress` shrinks Blender exports: meshopt
  for geometry, KTX2 (or WebP) for textures. It also checks them against the
  budget.
- **Physics colliders:** furniture colliders are convex shapes. Concave
  furniture is built from several of them.

## Publishing and licenses

- **Where:** itch.io as an HTML5 game, free with "$0 or donate" pricing.
- **Ads:** none for now. The option stays open because assets are **CC0 or
  CC-BY only**. Nothing "NonCommercial" goes in the game.
- **Credits:** every CC-BY author goes on the Credits screen
  (`src/credits.ts`).

## Ideas for later (out of scope for v1)

- More tricks: spinning an item on her nose, juggling between paws.
- Mobile touch controls.
- Arabic translation.
- Ads or a paid version, which the license rules allow.
