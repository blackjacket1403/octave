import * as THREE from 'three';
import type { Mode } from '../Mode';
import type { AnalysisFrame } from '../../audio/analysis';
import { BAND_COUNT } from '../../audio/analysis';
import { EnvelopeFollower, clamp01 } from '../../audio/smoothing';

/**
 * Mode 2 — Ink and Current.
 * The music is pigment moving through water across a sheet of paper.
 * Each voice is a coloured current at its register's depth; counterpoint
 * braids the currents across one another, unison merges them, and a big
 * swell floods the sheet with a wash of colour. Onsets are ink drops that
 * bloom and dissolve. Everything happens in one full-screen fragment
 * shader over domain-warped noise — painterly, never geometric.
 */

const MAX_DROPS = 10;

// pigments on paper: indigo melody, vermilion, gold ochre, umber, teal
const PIGMENTS = [
  new THREE.Color('#6e4012'), // bass — burnt sienna
  new THREE.Color('#c23a18'), // tenor — vermilion
  new THREE.Color('#c79018'), // alto — gold ochre
  new THREE.Color('#1f3f8c'), // soprano — ultramarine
  new THREE.Color('#177a70'), // brilliance — viridian teal
];

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0); // full-screen, camera-independent
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uAspect;
  uniform float uOctaves;     // quality: 4 / 3 / 2
  uniform float uFlood;       // slow total energy — the rising wash
  uniform float uFlux;        // texture business — wateriness
  uniform float uEnergy[${BAND_COUNT}];
  uniform float uPan[${BAND_COUNT}];
  uniform float uSal[${BAND_COUNT}];   // smoothed salience per voice
  uniform vec3 uColor[${BAND_COUNT}];
  uniform vec4 uDrops[${MAX_DROPS}];   // x, y, age 0..1, strength
  uniform vec3 uDropColor[${MAX_DROPS}];

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      if (float(i) >= uOctaves) break;
      v += a * noise(p);
      p = p * 2.03 + vec2(13.7, 7.1);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 p = vec2(vUv.x * uAspect, vUv.y);

    // the water: slow domain warp that everything is advected through
    vec2 q = vec2(fbm(p * 1.4 + vec2(uTime * 0.045, 0.0)),
                  fbm(p * 1.4 - vec2(0.0, uTime * 0.035) + 5.2));
    vec2 w = p + (q - 0.5) * (0.28 + uFlux * 0.34);

    // paper
    float grain = noise(p * 110.0) * 0.05 + noise(p * 23.0) * 0.04;
    vec3 col = vec3(0.945, 0.922, 0.868) - grain;

    float deposit = 0.0;

    // five currents, bass at the bottom, brilliance near the top
    for (int v = 0; v < ${BAND_COUNT}; v++) {
      float e = uEnergy[v];
      if (e < 0.015) continue;
      float fv = float(v);
      float baseY = 0.16 + 0.17 * fv;

      // each current meanders at its own rate; louder = bolder meander.
      // different frequencies make neighbouring currents braid.
      float meander = sin(w.x * (1.7 + fv * 0.83) + uTime * (0.10 + 0.05 * fv) + fv * 9.4) * 0.10
                    + sin(w.x * (3.9 + fv * 0.41) - uTime * (0.06 + 0.03 * fv) + fv * 3.1) * 0.05;
      float yC = baseY + meander * (0.55 + e * 1.1);

      float thick = 0.026 + e * 0.10 + uSal[v] * 0.025;
      float d = abs(w.y - yC);
      float body = exp(-pow(d / thick, 2.0) * 1.3);
      // a concentrated spine keeps each current legible inside its wash
      float spine = exp(-pow(d / (thick * 0.32), 2.0)) * 0.6;

      // ragged, feathered edges — pigment, not vector art
      float feather = fbm(w * 6.5 + fv * 17.0 + vec2(uTime * 0.06, 0.0));
      body = body * (0.62 + 0.38 * feather) + spine;

      // streaks flowing along the current
      float streak = 0.85 + 0.15 * sin(w.x * 24.0 - uTime * (0.9 + e * 2.2) + feather * 7.0 + fv * 5.0);

      // stereo: pigment density leans toward the side the voice sounds from
      float side = (vUv.x - 0.5) * 2.0;
      float lean = clamp(1.0 + uPan[v] * side * 1.3, 0.15, 2.0);

      float ink = body * streak * lean * clamp(e * 1.7, 0.0, 1.0) * (0.55 + uSal[v] * 0.45);
      ink = clamp(ink, 0.0, 0.96);
      col = mix(col, uColor[v], ink);
      deposit += ink;
    }

    // onset drops: blooms of ink that expand and dissolve
    for (int i = 0; i < ${MAX_DROPS}; i++) {
      float age = uDrops[i].z;
      float str = uDrops[i].w;
      if (str <= 0.001) continue;
      vec2 dp = vec2(uDrops[i].x * uAspect, uDrops[i].y);
      float r = 0.015 + age * 0.16;
      float dist = length(w - dp);
      float edge = fbm(w * 9.0 + dp * 31.0) * 0.35;
      float blot = smoothstep(r + 0.02 + edge * r, r * 0.35, dist);
      float a = blot * (1.0 - age) * (1.0 - age) * str * 0.8;
      col = mix(col, uDropColor[i], clamp(a, 0.0, 1.0));
      deposit += a;
    }

    // the flood: a sustained swell washes diluted pigment across the sheet
    float floodMask = fbm(w * 2.2 + vec2(0.0, uTime * 0.02)) * 0.6 + 0.4;
    vec3 floodTint = vec3(0.45, 0.42, 0.52);
    col = mix(col, floodTint, clamp(uFlood * uFlood * floodMask * 0.45, 0.0, 1.0));

    // wet pigment darkens where it pools
    col *= 1.0 - clamp(deposit, 0.0, 1.4) * 0.12;

    // vignette
    vec2 c = vUv - 0.5;
    col *= 1.0 - dot(c, c) * 0.32;

    gl_FragColor = vec4(col, 1.0);
  }
`;

interface Drop {
  x: number;
  y: number;
  age: number;
  strength: number;
  band: number;
}

export class InkCurrent implements Mode {
  private scene!: THREE.Scene;
  private mesh!: THREE.Mesh;
  private mat!: THREE.ShaderMaterial;
  private geo!: THREE.BufferGeometry;
  private time = 0;
  private aspect = 16 / 9;
  private drops: Drop[] = [];
  private salience: EnvelopeFollower[] = [];
  private energyArr = new Float32Array(BAND_COUNT);
  private panArr = new Float32Array(BAND_COUNT);
  private salArr = new Float32Array(BAND_COUNT);
  private dropArr = new Float32Array(MAX_DROPS * 4);
  private dropColorArr: THREE.Color[] = [];

  init(scene: THREE.Scene, _renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    this.scene = scene;
    this.aspect = camera.aspect;
    for (let b = 0; b < BAND_COUNT; b++) this.salience.push(new EnvelopeFollower(600, 1600));
    for (let i = 0; i < MAX_DROPS; i++) this.dropColorArr.push(new THREE.Color());

    this.geo = new THREE.PlaneGeometry(2, 2);
    this.mat = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uAspect: { value: this.aspect },
        uOctaves: { value: 4 },
        uFlood: { value: 0 },
        uFlux: { value: 0 },
        uEnergy: { value: this.energyArr },
        uPan: { value: this.panArr },
        uSal: { value: this.salArr },
        uColor: { value: PIGMENTS },
        uDrops: { value: this.dropArr },
        uDropColor: { value: this.dropColorArr },
      },
      depthWrite: false,
      depthTest: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 100;
    scene.add(this.mesh);
  }

  update(frame: AnalysisFrame, dt: number): void {
    this.time += dt;
    const dtMs = dt * 1000;

    for (let b = 0; b < BAND_COUNT; b++) {
      const band = frame.bands[b];
      this.energyArr[b] = band.energy;
      this.panArr[b] = band.pan;
      this.salArr[b] = this.salience[b].process(
        frame.salientBand === b ? frame.salience : 0,
        dtMs,
      );

      // a strong attack drips ink onto the sheet near the voice's current
      if (band.attack && band.attackStrength > 0.22 && this.drops.length < MAX_DROPS) {
        this.drops.push({
          x: 0.5 + band.pan * 0.32 + (Math.random() - 0.5) * 0.25,
          y: 0.16 + 0.17 * b + (Math.random() - 0.5) * 0.08,
          age: 0,
          strength: Math.min(1, band.attackStrength * 1.4),
          band: b,
        });
      }
    }

    for (const d of this.drops) d.age += dt / 3.2; // ~3s bloom
    this.drops = this.drops.filter((d) => d.age < 1);
    this.dropArr.fill(0);
    this.drops.forEach((d, i) => {
      this.dropArr[i * 4] = d.x;
      this.dropArr[i * 4 + 1] = d.y;
      this.dropArr[i * 4 + 2] = d.age;
      this.dropArr[i * 4 + 3] = d.strength;
      this.dropColorArr[i].copy(PIGMENTS[d.band]);
    });

    const u = this.mat.uniforms;
    u.uTime.value = this.time;
    u.uAspect.value = this.aspect;
    u.uFlood.value = clamp01((frame.energySlow - 0.45) / 0.5);
    u.uFlux.value = frame.flux;
  }

  resize(w: number, h: number): void {
    this.aspect = w / h;
  }

  setQuality(level: number): void {
    this.mat.uniforms.uOctaves.value = level >= 2 ? 4 : 3;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}
