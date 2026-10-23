# Knock It Off

A small browser game: you're a cat in a room, and everything on every surface
is yours to knock off. Desktop only, no server.

Built with Three.js, Rapier physics, TypeScript and Vite.

## Running

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
npm run preview    # serve dist/ locally
npm run compress   # compress Blender exports, see docs/blender-guide.md
```

## Controls

WASD / arrows move, Shift runs, Space jumps (ledges are climbed
automatically). Left/right click swipes with that paw; both buttons grab a
small item. While holding: click to throw (hold longer for more power), F to
toss it up and click at the top to spike it. M meows, R resets the room,
Esc pauses.

## Layout

```
src/
  main.ts           startup: device check, loading, menus
  config.ts         asset paths, cat rig mapping, gameplay tuning
  strings.ts        all player-facing text
  credits.ts        third-party credits shown in-game
  ui/ui.ts          loading screen, menus, pause, HUD
  game/Game.ts      renderer, physics loop, modes
  game/Cat.ts       cat controller: movement, scramble, swipes, grab, trick
  game/catVisual.ts placeholder cat and rigged GLB cat
  game/room.ts      room parsing (Blender conventions) and grey-box room
  game/props.ts     knockable objects, breaking, debris, reset
  game/CameraRig.ts third-person camera
  game/audio.ts     sound effects
scripts/compress-assets.mjs
docs/game-design.md the agreed game spec
docs/blender-guide.md Blender conventions, sizes and budgets
```

The grey-box room and placeholder cat are used until `assets.cat` /
`assets.room` in `src/config.ts` point at real models.

## Publishing on itch.io

1. `npm run build`
2. Zip the **contents** of `dist/` (so `index.html` is at the zip root).
3. On itch.io: create a new project, Kind of project **HTML**, upload the
   zip and tick "This file will be played in the browser".
4. Embed options: viewport 1280 × 720, enable the fullscreen button.
5. Pricing: **$0 or donate**.

Only CC0 and CC-BY assets go in the game, and every CC-BY author is listed
in `src/credits.ts`, so ads or paid versions stay possible later.
