import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

// GLTF loader that understands the compression used by `npm run compress`.
export function makeGltfLoader(renderer: THREE.WebGLRenderer, manager: THREE.LoadingManager): GLTFLoader {
  const ktx2 = new KTX2Loader(manager).detectSupport(renderer);
  return new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);
}
