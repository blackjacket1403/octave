import * as THREE from 'three';
import type { Mode } from '../Mode';
import type { AnalysisFrame } from '../../audio/analysis';
import { BAND_COUNT } from '../../audio/analysis';
import { EnvelopeFollower, clamp01, lerp, smoothK } from '../../audio/smoothing';
import { Strand } from './Strand';
import { Atmosphere } from './Atmosphere';
import { CameraRig } from './CameraRig';
import { BAND_COLORS, BAND_HEIGHT, BAND_HOME_PAN, DIM_COLOR } from './palette';

/**
 * Mode 1 — The Luminous Hall.
 * Five register bands are five aurora strands of light hanging on a shallow
 * arc around the podium, like bow strokes suspended in the air. Loudness
 * approaches and billows, attention sharpens and sheds sparks, onsets travel
 * along the strands as pulses, climaxes warm the hall and leave afterglow.
 */

const ARC_HALF_ANGLE = THREE.MathUtils.degToRad(30);
const ARC_ORIGIN = new THREE.Vector3(0, 0, 11); // behind the camera; arc bows away
const DIST_FAR = 23; // silent strands recede into the haze
const DIST_NEAR = 15; // fortissimo arrives here

/** Per-band strand character: low voices broad and heavy, high voices fine. */
const STRAND_HALF_ANGLE = [0.34, 0.29, 0.245, 0.205, 0.17];
const STRAND_THICKNESS = [1.5, 1.2, 0.95, 0.7, 0.5];

// deterministic rng so reloads look identical
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class LuminousHall implements Mode {
  private scene!: THREE.Scene;
  private renderer!: THREE.WebGLRenderer;
  private group = new THREE.Group();
  private strands: Strand[] = [];
  private atmosphere!: Atmosphere;
  private rig = new CameraRig();

  private time = 0;
  private warmth = 0; // slow thermal memory of the piece
  private afterglow = 0; // floor memory of the last climax

  // per-band smoothed display state, so every transition is a crossfade
  private dispAngle: number[] = [];
  private dispDist: number[] = [];
  private dispHeight: number[] = [];
  private salienceEnv: EnvelopeFollower[] = [];
  private colors: THREE.Color[] = [];
  private scratchColor = new THREE.Color();

  init(scene: THREE.Scene, renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    this.scene = scene;
    this.renderer = renderer;
    const rng = mulberry32(0x0c7a5e);
    this.atmosphere = new Atmosphere(rng);
    this.group.add(this.atmosphere.group);

    for (let b = 0; b < BAND_COUNT; b++) {
      const strand = new Strand(rng, STRAND_THICKNESS[b]);
      this.strands.push(strand);
      this.group.add(strand.group);
      this.dispAngle.push(BAND_HOME_PAN[b] * ARC_HALF_ANGLE);
      this.dispDist.push(DIST_FAR);
      this.dispHeight.push(BAND_HEIGHT[b]);
      // attention arrives in ~0.6s and lets go over ~1.6s — a slow crossfade
      this.salienceEnv.push(new EnvelopeFollower(600, 1600));
      this.colors.push(BAND_COLORS[b].clone());
    }

    scene.add(this.group);
    this.rig.init(camera);
  }

  update(frame: AnalysisFrame, dt: number): void {
    this.time += dt;
    const dtMs = dt * 1000;

    // ---- hall memory -------------------------------------------------------
    const warmthTarget = clamp01((frame.energySlow - 0.18) * 1.4);
    const kWarm = smoothK(warmthTarget > this.warmth ? 14000 : 30000, dtMs);
    this.warmth += (warmthTarget - this.warmth) * kWarm;

    const climax = clamp01((frame.energySlow - 0.72) / 0.28);
    this.afterglow = Math.max(climax, this.afterglow * Math.exp(-dt / 20));

    const px = this.renderer.getPixelRatio();
    const density = clamp01(frame.flux * 0.65 + (frame.activeBands / BAND_COUNT) * 0.55);
    this.atmosphere.update(this.time, this.warmth, density, this.afterglow, frame.energyFast, px);

    // ---- the five voices ---------------------------------------------------
    let leanTarget: THREE.Vector3 | null = null;
    let leanWeight = 0;

    for (let b = 0; b < BAND_COUNT; b++) {
      const band = frame.bands[b];
      const salient = this.salienceEnv[b].process(
        frame.salientBand === b ? frame.salience : 0,
        dtMs,
      );

      // measured pan earns trust as the band gets louder; quiet strands rest
      // in their orchestra seating so the dormant hall still has shape
      const panTrust = clamp01(band.energy * 3) * 0.9;
      const pan = lerp(BAND_HOME_PAN[b], band.pan, panTrust);

      // targets, then glide: nothing in the hall ever jumps
      const angleT = pan * ARC_HALF_ANGLE;
      const distT = lerp(DIST_FAR, DIST_NEAR, clamp01(band.energy * 1.1));
      const heightT = BAND_HEIGHT[b] + (band.pitch - 0.5) * 1.8;
      this.dispAngle[b] += (angleT - this.dispAngle[b]) * smoothK(900, dtMs);
      this.dispDist[b] += (distT - this.dispDist[b]) * smoothK(1100, dtMs);
      this.dispHeight[b] += (heightT - this.dispHeight[b]) * smoothK(1400, dtMs);

      // non-salient voices desaturate slightly toward the hall's ambience
      this.scratchColor
        .copy(BAND_COLORS[b])
        .lerp(DIM_COLOR, (1 - salient) * frame.salience * 0.4);
      this.colors[b].copy(this.scratchColor);

      // sound blooms; a faint ember remains even in silence
      const intensity = Math.min(
        0.9,
        0.05 + Math.pow(band.energy, 1.25) * 0.6 * (1 + salient * 0.6) + band.attackStrength * 0.12,
      );

      this.strands[b].update(
        this.time,
        dt,
        ARC_ORIGIN,
        this.dispAngle[b],
        STRAND_HALF_ANGLE[b],
        this.dispDist[b],
        this.dispHeight[b],
        this.colors[b],
        band.energy,
        intensity,
        salient,
        frame.flux,
        px,
      );

      if (band.attack && band.attackStrength > 0.15) {
        this.strands[b].pulse(band.attackStrength);
      }

      if (salient > leanWeight) {
        leanWeight = salient;
        leanTarget = this.strands[b].center;
      }
    }

    // ---- camera ------------------------------------------------------------
    this.rig.setLeanTarget(leanTarget, leanWeight);
    this.rig.update(dt, frame.energySlow);
  }

  resize(_w: number, _h: number): void {
    /* no internal render targets */
  }

  setQuality(level: number): void {
    this.atmosphere.setQuality(level);
    for (const s of this.strands) s.setMirrorVisible(level >= 1);
  }

  setLook(x: number, y: number): void {
    this.rig.setLook(x, y);
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const s of this.strands) s.dispose();
    this.atmosphere.dispose();
    this.strands = [];
  }
}
