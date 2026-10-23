// Touch-only devices (phones, tablets without a mouse) can't play.
export function isTouchOnly(): boolean {
  const hasFinePointer = matchMedia('(any-pointer: fine)').matches;
  const coarsePointer = matchMedia('(pointer: coarse)').matches;
  return !hasFinePointer && coarsePointer;
}

export function hasWebGL2(): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}
