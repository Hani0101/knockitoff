// Asset paths and gameplay tuning. Distances in meters, times in seconds.

export const assets = {
  // Rigged cat from assets-src/cat.glb (npm run compress). Set to null to
  // fall back to the grey-box placeholder cat.
  cat: 'models/cat.glb' as string | null,
  // Set to 'models/room.glb' once the Blender room exists.
  // While null, a grey-box room is built in code.
  room: null as string | null,
  // Optional sound files (in public/sounds). Missing ones fall back to synthesized sounds.
  sounds: {
    music: null as string | null,
  },
};

// How the cat model maps onto the game. Adjust after importing the real rig.
export const catModel = {
  scale: 1,
  // Extra yaw so the model faces -Z (the game's "forward").
  yawOffset: 0,
  // Bone names used for code-driven head look-at and tail sway, from the
  // Rigify cat rig's deform bones (tail listed base to tip).
  headBone: 'DEF-spine.006',
  // Neck bones, base first. Head turns are shared with these so the neck
  // bends instead of the head twisting on its own.
  neckBones: ['DEF-spine.004', 'DEF-spine.005'],
  tailBones: ['DEF-tail.001', 'DEF-tail.002', 'DEF-tail.003', 'DEF-tail.004'],
};

export const tuning = {
  gravity: 12,

  // Cat body
  catRadius: 0.15,
  catHalfHeight: 0.04,
  walkSpeed: 1.6,
  runSpeed: 3.4,
  turnSpeed: 12,
  // Fixed jump: feet rise this high above the takeoff surface.
  jumpHeight: 0.8,
  // Ledge scramble: how far above the feet a ledge can be grabbed mid-air.
  scrambleReach: 0.55,
  scrambleDuration: 0.5,
  catMass: 4,

  // Swipes
  swipeWindup: 0.08,
  swipeCooldown: 0.35,
  swipeRadius: 0.3,
  swipeSpeed: 4.2,
  swipeSideKick: 0.35,
  swipeLift: 0.3,
  // Window for pressing the second mouse button to make it a two-paw grab.
  grabChordWindow: 0.09,

  // Grab and throw
  grabReach: 0.55,
  // Where a held item floats, relative to the cat's feet: in front of her
  // chest while she sits up. The hold animations pose the paws around it.
  holdHeight: 0.32,
  holdForward: 0.2,
  throwMinSpeed: 3,
  throwMaxSpeed: 10,
  throwChargeTime: 0.8,

  // Trick
  trickTossSpeed: 4.2,
  spikeSpeed: 12,
  // The spike window opens when the item's vertical speed drops below
  // `spikeOpenVy` and closes once it falls faster than `spikeCloseVy`.
  spikeOpenVy: 1.2,
  spikeCloseVy: -2.2,

  // Breaking
  breakSpeed: 3.2,
  maxDebris: 300,

  // Camera
  cameraDistance: 2.2,
  cameraHeight: 0.35,
  cameraMinPitch: -0.6,
  cameraMaxPitch: 1.1,
  mouseSensitivity: 0.0025,
};
