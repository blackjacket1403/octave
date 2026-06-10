import * as THREE from 'three';
import type { Mode } from '../Mode';
import type { AnalysisFrame } from '../../audio/analysis';
import { BAND_COUNT } from '../../audio/analysis';
import { EnvelopeFollower, clamp, clamp01 } from '../../audio/smoothing';

/**
 * Mode 3 — The Growing Garden.
 * Phrases grow as living forms on parchment: each voice is a shoot whose
 * stem lengthens while it sounds, curling with its pitch; onsets put out
 * leaves; climaxes open golden blooms. Everything is painted into a
 * persistent canvas that is never erased — by the end of the piece the
 * whole work's structure stands as a grown landscape.
 */

const MAX_DEPOSITS = 96; // strokes painted per frame
const BLOOM_COOLDOWN = 1.6;

const VOICE_COLORS = [
  new THREE.Color('#7a5a33'), // bass — walnut stems
  new THREE.Color('#8a7d3a'), // tenor — olive
  new THREE.Color('#5f8048'), // alto — moss green
  new THREE.Color('#46808a'), // soprano — teal tendrils
  new THREE.Color('#a06f9d'), // brilliance — heather violet
];
const LEAF_TINT = new THREE.Color('#94a456');
const BLOOM_GOLD = new THREE.Color('#c79a3b');
const SOIL = new THREE.Color('#3a2e22');

const strokeVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    vUv = uv;
    #ifdef USE_INSTANCING_COLOR
      vColor = instanceColor;
    #else
      vColor = vec3(1.0);
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const strokeFragment = /* glsl */ `
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    vec2 c = (vUv - 0.5) * 2.0;
    float d = length(c);
    float a = smoothstep(1.0, 0.45, d) * uOpacity;
    if (a <= 0.01) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

const compositeVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const compositeFragment = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uWarmth;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  void main() {
    vec3 paperCool = vec3(0.93, 0.905, 0.85);
    vec3 paperWarm = vec3(0.94, 0.89, 0.80);
    vec3 paper = mix(paperCool, paperWarm, uWarmth);
    paper -= hash(vUv * 700.0) * 0.035 + hash(vUv * 90.0) * 0.03;
    vec4 g = texture2D(uMap, vUv);
    vec3 col = mix(paper, g.rgb, clamp(g.a, 0.0, 1.0));
    vec2 c = vUv - 0.5;
    col *= 1.0 - dot(c, c) * 0.5;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const tipVertex = /* glsl */ `
  uniform vec2 uPos;    // NDC
  uniform float uScale; // NDC units
  uniform float uAspect;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec2 p = uPos + position.xy * uScale * vec2(1.0, uAspect);
    gl_Position = vec4(p, 0.0, 1.0);
  }
`;

const tipFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float a = exp(-d * d * 6.0) * uIntensity;
    if (a <= 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

interface Turtle {
  x: number;
  y: number;
  angle: number; // radians, π/2 = straight up
  curl: number;
  sinceLeaf: number;
  sinceBloom: number;
  leafSide: number;
}

interface Deposit {
  x: number;
  y: number;
  rot: number;
  len: number;
  width: number;
  color: THREE.Color;
}

export class Garden implements Mode {
  private scene!: THREE.Scene;
  private renderer!: THREE.WebGLRenderer;
  private group = new THREE.Group();

  private rt: THREE.WebGLRenderTarget | null = null;
  private strokeScene = new THREE.Scene();
  private strokeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  private strokes!: THREE.InstancedMesh;
  private strokeMat!: THREE.ShaderMaterial;
  private compositeMat!: THREE.ShaderMaterial;
  private tipMats: THREE.ShaderMaterial[] = [];
  private geometries: THREE.BufferGeometry[] = [];

  private turtles: Turtle[] = [];
  private salience: EnvelopeFollower[] = [];
  private deposits: Deposit[] = [];
  private depositColors: THREE.Color[] = [];
  private time = 0;
  private aspect = 16 / 9;
  private needsClear = true;
  private rtScale = 1;
  private dummy = new THREE.Object3D();
  private rng = (() => {
    let s = 987654321;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
  })();

  init(scene: THREE.Scene, renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    this.scene = scene;
    this.renderer = renderer;
    this.aspect = camera.aspect;
    for (let i = 0; i < MAX_DEPOSITS; i++) this.depositColors.push(new THREE.Color());

    // persistent canvas
    this.createTarget();

    // stroke painter (instanced soft ellipses)
    const quad = new THREE.PlaneGeometry(1, 1);
    this.strokeMat = new THREE.ShaderMaterial({
      vertexShader: strokeVertex,
      fragmentShader: strokeFragment,
      uniforms: { uOpacity: { value: 0.88 } },
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    this.strokes = new THREE.InstancedMesh(quad, this.strokeMat, MAX_DEPOSITS);
    this.strokes.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_DEPOSITS * 3),
      3,
    );
    this.strokes.frustumCulled = false;
    this.strokes.count = 0;
    this.strokeScene.add(this.strokes);

    // composite quad in the main scene
    const screen = new THREE.PlaneGeometry(2, 2);
    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: compositeVertex,
      fragmentShader: compositeFragment,
      uniforms: {
        uMap: { value: this.rt!.texture },
        uWarmth: { value: 0 },
      },
      depthWrite: false,
      depthTest: false,
    });
    const composite = new THREE.Mesh(screen, this.compositeMat);
    composite.frustumCulled = false;
    composite.renderOrder = 50;
    this.group.add(composite);

    // live glowing growth tips
    const tipGeo = new THREE.PlaneGeometry(1, 1);
    for (let b = 0; b < BAND_COUNT; b++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: tipVertex,
        fragmentShader: tipFragment,
        uniforms: {
          uPos: { value: new THREE.Vector2() },
          uScale: { value: 0.02 },
          uAspect: { value: this.aspect },
          uColor: { value: VOICE_COLORS[b].clone().lerp(new THREE.Color('#ffffff'), 0.45) },
          uIntensity: { value: 0 },
        },
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        depthTest: false,
      });
      this.tipMats.push(mat);
      const tip = new THREE.Mesh(tipGeo, mat);
      tip.frustumCulled = false;
      tip.renderOrder = 51;
      this.group.add(tip);

      this.turtles.push(this.newShoot(b, 0));
      this.salience.push(new EnvelopeFollower(600, 1600));
    }

    this.geometries.push(quad, screen, tipGeo);
    scene.add(this.group);
    this.sowSoil();
  }

  private createTarget(): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.min(2048, Math.floor(size.x * this.rtScale));
    const h = Math.min(2048, Math.floor(size.y * this.rtScale));
    this.rt?.dispose();
    this.rt = new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    });
    this.strokeCam.left = -this.aspect;
    this.strokeCam.right = this.aspect;
    this.strokeCam.updateProjectionMatrix();
    this.needsClear = true;
  }

  private newShoot(band: number, pan: number): Turtle {
    return {
      x: clamp(pan * this.aspect * 0.7 + (this.rng() - 0.5) * this.aspect * 0.7, -this.aspect * 0.92, this.aspect * 0.92),
      y: -0.99,
      angle: Math.PI / 2 + (this.rng() - 0.5) * 0.3,
      curl: 0,
      sinceLeaf: 0,
      sinceBloom: band, // stagger first blooms
      leafSide: this.rng() > 0.5 ? 1 : -1,
    };
  }

  /** A dark soil line so the first shoots have ground to stand in. */
  private sowSoil(): void {
    for (let i = 0; i < 40; i++) {
      const t = i / 39;
      this.deposits.push({
        x: (t * 2 - 1) * this.aspect,
        y: -0.985 + (this.rng() - 0.5) * 0.02,
        rot: (this.rng() - 0.5) * 0.4,
        len: 0.16 + this.rng() * 0.1,
        width: 0.035 + this.rng() * 0.02,
        color: SOIL.clone().offsetHSL(0, 0, (this.rng() - 0.5) * 0.06),
      });
    }
  }

  update(frame: AnalysisFrame, dt: number): void {
    this.time += dt;
    const dtMs = dt * 1000;

    for (let b = 0; b < BAND_COUNT; b++) {
      const band = frame.bands[b];
      const t = this.turtles[b];
      const sal = this.salience[b].process(frame.salientBand === b ? frame.salience : 0, dtMs);
      t.sinceLeaf += dt;
      t.sinceBloom += dt;

      const tipMat = this.tipMats[b];
      tipMat.uniforms.uAspect.value = this.aspect;
      (tipMat.uniforms.uPos.value as THREE.Vector2).set(t.x / this.aspect, t.y);
      tipMat.uniforms.uScale.value = 0.015 + band.energy * 0.035 + sal * 0.02;
      tipMat.uniforms.uIntensity.value = band.energy * (0.35 + sal * 0.65);

      if (band.energy < 0.03 || !frame.playing) continue;

      // grow: speed from loudness; curl wanders with pitch and texture but
      // always eases back toward vertical, so stems wave instead of keeling
      const step = band.energy * dt * (0.11 + sal * 0.05);
      const wander =
        (band.pitch - 0.5) * 2.2 +
        Math.sin(this.time * (0.7 + b * 0.13) + b * 2.1) * (0.8 + frame.flux * 1.4);
      t.curl += (wander - t.curl * 1.6) * dt;
      t.curl = clamp(t.curl, -1.2, 1.2);
      t.angle = Math.PI / 2 + t.curl * 0.75;

      const nx = t.x + Math.cos(t.angle) * step;
      const ny = t.y + Math.sin(t.angle) * step;

      if (this.deposits.length < MAX_DEPOSITS) {
        this.deposits.push({
          x: (t.x + nx) / 2,
          y: (t.y + ny) / 2,
          rot: t.angle,
          len: Math.max(step * 2.6, 0.01),
          width: 0.009 + band.energy * 0.02 + sal * 0.005,
          color: VOICE_COLORS[b]
            .clone()
            .lerp(LEAF_TINT, clamp01(band.pitch * 0.4))
            .offsetHSL(0, 0, sal * 0.08),
        });
      }
      t.x = nx;
      t.y = ny;

      // leaves on attacks; golden blooms at sustained climaxes
      const blooming =
        band.attackStrength > 0.45 && frame.energySlow > 0.58 && t.sinceBloom > BLOOM_COOLDOWN;
      if (blooming) {
        t.sinceBloom = 0;
        const petals = 7;
        const size = 0.025 + band.energy * 0.03;
        for (let p = 0; p < petals && this.deposits.length < MAX_DEPOSITS; p++) {
          const a = (p / petals) * Math.PI * 2 + this.rng() * 0.4;
          this.deposits.push({
            x: t.x + Math.cos(a) * size * 0.8,
            y: t.y + Math.sin(a) * size * 0.8,
            rot: a,
            len: size * 1.9,
            width: size * 0.85,
            color: BLOOM_GOLD.clone().offsetHSL(0, 0, (this.rng() - 0.5) * 0.12),
          });
        }
      } else if (band.attack && band.attackStrength > 0.12 && t.sinceLeaf > 0.3) {
        t.sinceLeaf = 0;
        t.leafSide *= -1;
        const la = t.angle + (Math.PI / 2.6) * t.leafSide;
        const size = 0.016 + band.attackStrength * 0.028;
        if (this.deposits.length < MAX_DEPOSITS) {
          this.deposits.push({
            x: t.x + Math.cos(la) * size,
            y: t.y + Math.sin(la) * size,
            rot: la,
            len: size * 2.6,
            width: size,
            color: VOICE_COLORS[b].clone().lerp(LEAF_TINT, 0.65),
          });
        }
      }

      // off the page: the phrase is spent; seed a new shoot where the voice
      // currently sits in the stereo field
      if (t.y > 0.94 || Math.abs(t.x) > this.aspect * 0.96) {
        this.turtles[b] = this.newShoot(b, band.pan);
      }
    }

    this.paint();
    this.compositeMat.uniforms.uWarmth.value = clamp01(frame.energySlow * 1.2);
  }

  /** Flush this frame's deposits into the persistent canvas. */
  private paint(): void {
    if (!this.rt) return;
    const n = Math.min(this.deposits.length, MAX_DEPOSITS);
    for (let i = 0; i < n; i++) {
      const d = this.deposits[i];
      this.dummy.position.set(d.x, d.y, 0);
      this.dummy.rotation.set(0, 0, d.rot);
      this.dummy.scale.set(d.len, d.width, 1);
      this.dummy.updateMatrix();
      this.strokes.setMatrixAt(i, this.dummy.matrix);
      this.strokes.setColorAt(i, d.color);
    }
    this.strokes.count = n;
    this.deposits.length = 0;
    if (n === 0 && !this.needsClear) return;

    this.strokes.instanceMatrix.needsUpdate = true;
    if (this.strokes.instanceColor) this.strokes.instanceColor.needsUpdate = true;

    const prevAutoClear = this.renderer.autoClear;
    this.renderer.setRenderTarget(this.rt);
    if (this.needsClear) {
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear();
      this.needsClear = false;
    }
    this.renderer.autoClear = false;
    this.renderer.render(this.strokeScene, this.strokeCam);
    this.renderer.autoClear = prevAutoClear;
    this.renderer.setRenderTarget(null);
  }

  resize(w: number, h: number): void {
    this.aspect = w / h;
    // the canvas must be rebuilt at the new size; the garden replants
    this.createTarget();
    this.compositeMat.uniforms.uMap.value = this.rt!.texture;
    this.sowSoil();
    for (let b = 0; b < BAND_COUNT; b++) this.turtles[b] = this.newShoot(b, 0);
  }

  setQuality(level: number): void {
    const scale = level >= 2 ? 1 : level === 1 ? 0.75 : 0.5;
    if (scale !== this.rtScale) {
      this.rtScale = scale;
      this.createTarget();
      this.compositeMat.uniforms.uMap.value = this.rt!.texture;
      this.sowSoil();
    }
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.rt?.dispose();
    this.rt = null;
    for (const g of this.geometries) g.dispose();
    this.strokeMat.dispose();
    this.compositeMat.dispose();
    for (const m of this.tipMats) m.dispose();
  }
}
