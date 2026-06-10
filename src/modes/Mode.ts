import type * as THREE from 'three';
import type { AnalysisFrame } from '../audio/analysis';

/**
 * A visualization mode is a self-contained visual world. It consumes only
 * AnalysisFrame — never the Web Audio API — so every mode works with every
 * source automatically.
 */
export interface Mode {
  init(scene: THREE.Scene, renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void;
  /** Called every animation frame. dt is in seconds. */
  update(frame: AnalysisFrame, dt: number): void;
  resize(width: number, height: number): void;
  dispose(): void;
  /**
   * Adaptive quality hook. 2 = full, 1 = reduced, 0 = minimal.
   * Optional; modes that ignore it simply stay at full quality.
   */
  setQuality?(level: number): void;
  /** Pointer-driven look, in normalized -1..1 offsets. Optional. */
  setLook?(x: number, y: number): void;
  /** Hover/touch position in NDC (-1..1); modes may react to presence. */
  setPointer?(x: number, y: number): void;
  /** A click/tap that wasn't a drag, in NDC. Modes may detonate things. */
  tap?(x: number, y: number): void;
}

export interface ModeDefinition {
  id: string;
  name: string;
  description: string;
  /** Modes not yet built are listed but unselectable. */
  available: boolean;
  create?: () => Mode;
}
