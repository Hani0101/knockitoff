// Every third-party asset or library in the shipped game goes here.
// CC-BY assets must be listed with author and license.
export interface Credit {
  what: string;
  author: string;
  license: string;
  url?: string;
}

export const credits: Credit[] = [
  { what: 'Three.js', author: 'three.js authors', license: 'MIT', url: 'https://threejs.org' },
  { what: 'Rapier physics', author: 'Dimforge', license: 'Apache-2.0', url: 'https://rapier.rs' },
  { what: 'Low Poly Cat', author: 'volkanongun', license: 'CC BY 4.0', url: 'https://sketchfab.com/3d-models/low-poly-cat-1e7143dfafd04ff4891efcb06949a0b4' },
  // Add this when the final cat replaces the placeholder:
  // { what: 'Cat 3D Model', author: 'Empire', license: 'CC BY 4.0', url: 'https://sketchfab.com/3d-models/cat-3d-model-free-0db8c53b5b3d474b8a7c90e2350994f6' },
];
