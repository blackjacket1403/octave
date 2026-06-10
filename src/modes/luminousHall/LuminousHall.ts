import * as THREE from 'three';
import type { Mode } from '../Mode';
import type { AnalysisFrame } from '../../audio/analysis';
import { BAND_COUNT } from '../../audio/analysis';
import { clamp01, lerp, smoothK } from '../../audio/smoothing';
import { LightBody } from './LightBody';
import { Ripples } from './Ripples';
import { Atmosphere } from './Atmosphere';
import { CameraRig } from './CameraRig';
import { BAND_COLORS, BAND_HEIGHT, BAND_HOME_PAN, DIM_COLOR } from './palette';

/**
 * Mode 1 — The Luminous Hall.
 * Five register bands are five bodies of light arranged like orchestra
 * seating around the podium. Loudness approaches, attention tightens and
 * trails, climaxes warm the hall and leave afterglow on the floor.
 */

/** Arc geometry: bodies sit on a shallow arc in front of the viewer. */
const ARC_HALF_ANGLE = THREE.MathUtils.degToRad(34);
const ARC_ORIGIN = new THREE.Vector3(0, 0, 11); // behind the camera; arc bows away
const DIST_FAR = 24; // silent bodies recede here
const DIST_NEAR = 14.5; // fortissimo arrives here

// deterministic rng so reloads look identical (and dispose/recreate matches)
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
  private bodies: LightBody[] = [];
  private ripples = new Ripples();
  private atmosphere!: Atmosphere;
  private rig = new CameraRig();

  private time = 0;
  private warmth = 0; // slow thermal memory of the piece
  private afterglow = 0; // floor memory of the last climax
  private positions: THREE.Vector3[] = [];
  private colors: THREE.Color[] = [];
  private scratchColor = new THREE.Color();
  private scratchVec = new THREE.Vector3();

  init(scene: THREE.Scene, renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    this.scene = scene;
    this.renderer = renderer;
    const rng = mulberry32(0x0c7a5e);
    this.atmosphere = new Atmosphere(rng);
    this.group.add(this.atmosphere.group);

    for (let b = 0; b < BAND_COUNT; b++) {
      const body = new LightBody(rng);
      this.bodies.push(body);
      this.group.add(body.group);
      this.positions.push(this.bandPosition(b, BAND_HOME_PAN[b], 0, 0.5, new THREE.Vector3()));
      this.colors.push(BAND_COLORS[b].clone());
    }

    this.group.add(this.ripples.group);
    scene.add(this.group);
    this.rig.init(camera);
  }

  /** Where a band with the given pan/energy/pitch sits in the hall. */
  private bandPosition(
    band: number,
    pan: number,
    energy: number,
    pitch: number,
    out: THREE.Vector3,
  ): THREE.Vector3 {
    const angle = pan * ARC_HALF_ANGLE;
    // loudness approaches the podium; silence recedes into the haze
    const dist = lerp(DIST_FAR, DIST_NEAR, clamp01(energy * 1.15));
    out.set(
      ARC_ORIGIN.x + Math.sin(angle) * dist,
      BAND_HEIGHT[band] + (pitch - 0.5) * 2.2,
      ARC_ORIGIN.z - Math.cos(angle) * dist,
    );
    return out;
  }

  update(frame: AnalysisFrame, dt: number): void {
    this.time += dt;
    const dtMs = dt * 1000;

    // ---- hall memory -------------------------------------------------------
    // sustained energy warms the ambient tone over ~14s; quiet cools over ~30s
    const warmthTarget = clamp01((frame.energySlow - 0.18) * 1.4);
    const kWarm = smoothK(warmthTarget > this.warmth ? 14000 : 30000, dtMs);
    this.warmth += (warmthTarget - this.warmth) * kWarm;

    // climaxes leave afterglow that fades over ~20s
    const climax = clamp01((frame.energySlow - 0.72) / 0.28);
    this.afterglow = Math.max(climax, this.afterglow * Math.exp(-dt / 20));

    const px = this.renderer.getPixelRatio();
    const density = clamp01(frame.flux * 0.65 + (frame.activeBands / BAND_COUNT) * 0.55);
    this.atmosphere.update(this.time, this.warmth, density, this.afterglow, frame.energyFast, px);

    // ---- the five voices ---------------------------------------------------
    for (let b = 0; b < BAND_COUNT; b++) {
      const band = frame.bands[b];
      const isSalient = frame.salientBand === b;
      const salientLevel = isSalient ? frame.salience : 0;

      // measured pan earns trust as the band gets louder; quiet bands sit in
      // their default orchestra seating so the dormant hall still has shape
      const panTrust = clamp01(band.energy * 3) * 0.9;
      const pan = lerp(BAND_HOME_PAN[b], band.pan, panTrust);

      this.bandPosition(b, pan, band.energy, band.pitch, this.scratchVec);
      // position params are already envelope-smoothed; this final lerp adds
      // a touch of mass so bodies glide rather than steer
      this.positions[b].lerp(this.scratchVec, smoothK(280, dtMs));

      // non-salient voices desaturate slightly; the melody holds full color
      const dim = (1 - salientLevel * 0.9) * frame.salience * 0.45;
      this.scratchColor.copy(BAND_COLORS[b]).lerp(DIM_COLOR, isSalient ? 0 : dim);
      this.colors[b].copy(this.scratchColor);

      // sound blooms: brightness from energy, a boost for the salient voice,
      // a brief glint on attacks — and a faint ember even in silence
      const intensity = Math.min(
        0.95,
        0.05 +
          Math.pow(band.energy, 1.3) * 0.7 * (1 + salientLevel * 0.5) +
          band.attackStrength * 0.18,
      );

      // salient swarm tightens; loud swarms swell
      const spread = (1.8 + band.energy * 1.3) * (1 - salientLevel * 0.34);

      this.bodies[b].update(
        this.time,
        this.positions[b],
        this.colors[b],
        band.energy,
        intensity,
        spread,
        salientLevel,
        px,
      );

      if (band.attack && band.attackStrength > 0.12) {
        this.ripples.spawn(this.positions[b], this.colors[b], band.attackStrength);
      }
    }

    this.ripples.update(dt);

    // ---- camera ------------------------------------------------------------
    this.rig.setLeanTarget(this.positions[frame.salientBand], frame.salience);
    this.rig.update(dt, frame.energySlow);
  }

  resize(_w: number, _h: number): void {
    /* no internal render targets */
  }

  setQuality(level: number): void {
    this.atmosphere.setQuality(level);
    for (const body of this.bodies) body.setMirrorVisible(level >= 1);
  }

  setLook(x: number, y: number): void {
    this.rig.setLook(x, y);
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const body of this.bodies) body.dispose();
    this.ripples.dispose();
    this.atmosphere.dispose();
    this.bodies = [];
  }
}
