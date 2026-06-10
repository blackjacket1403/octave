import * as THREE from 'three';
import type { Mode } from '../Mode';
import type { AnalysisFrame } from '../../audio/analysis';
import { BAND_COUNT } from '../../audio/analysis';
import { EnvelopeFollower, clamp, clamp01 } from '../../audio/smoothing';

/**
 * Mode 3 — The Growing Garden.
 * Phrases grow as climbing vines on parchment: each voice is a tapering
 * tendril whose curvature follows its pitch, curling into tight spirals
 * when the music ornaments, putting out paired leaves as it climbs, and
 * opening petaled blooms at climaxes. Vines finish, and new shoots rise
 * where the voice now sounds. The canvas is never erased — the finished
 * piece stands as a grown landscape of the work's structure.
 */

const MAX_STEMS = 96; // stem strokes painted per frame
const MAX_FOLIAGE = 64; // leaves/petals painted per frame
const BLOOM_COOLDOWN = 3.5;

const VOICE_COLORS = [
  new THREE.Color('#6e5230'), // bass — walnut
  new THREE.Color('#7d7434'), // tenor — olive
  new THREE.Color('#4f7a40'), // alto — moss green
  new THREE.Color('#3f7a80'), // soprano — teal tendrils
  new THREE.Color('#96689b'), // brilliance — wisteria
];
const LEAF_TINT = new THREE.Color('#9cb55e');
const BLOOM_GOLD = new THREE.Color('#cf9d35');
const BLOOM_HEART = new THREE.Color('#8a5a18');
const SOIL = new THREE.Color('#3a2e22');

// ---------------------------------------------------------------------------
// shaders
// ---------------------------------------------------------------------------

const stemVertex = /* glsl */ `
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

const stemFragment = /* glsl */ `
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    vec2 c = (vUv - 0.5) * 2.0;
    float d = length(c);
    float a = smoothstep(1.0, 0.5, d) * uOpacity;
    if (a <= 0.01) discard;
    // round stroke with a lit edge, like a turned stem catching light
    vec3 col = vColor * (0.9 + 0.18 * smoothstep(0.4, -0.6, c.y));
    gl_FragColor = vec4(col, a);
  }
`;

const leafVertex = stemVertex;

const leafFragment = /* glsl */ `
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    float along = vUv.x;
    float across = (vUv.y - 0.5) * 2.0;
    // pointed leaf silhouette: widest a third of the way up, sharp tip
    float env = pow(max(sin(3.14159 * pow(along, 0.72)), 0.0), 0.8);
    float a = (1.0 - smoothstep(env * 0.72, env, abs(across))) * uOpacity;
    if (a <= 0.012) discard;
    // midrib and gentle shading toward the edges
    float rib = smoothstep(0.0, 0.16, abs(across));
    vec3 col = vColor * (0.78 + 0.22 * rib) * (0.85 + 0.15 * along);
    gl_FragColor = vec4(col, a);
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

// ---------------------------------------------------------------------------

interface Turtle {
  x: number;
  y: number;
  angle: number; // radians, π/2 = straight up
  kSlow: number; // smooth curvature, rad per unit length
  curlRemaining: number; // arc length left in the current tendril curl
  curlSign: number;
  len: number; // length grown on this shoot
  maxLen: number;
  leafAcc: number; // distance since the last leaf pair
  sinceBloom: number;
  leafSide: number;
}

interface Stroke {
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
  private stems!: THREE.InstancedMesh;
  private foliage!: THREE.InstancedMesh;
  private stemMat!: THREE.ShaderMaterial;
  private leafMat!: THREE.ShaderMaterial;
  private compositeMat!: THREE.ShaderMaterial;
  private tipMats: THREE.ShaderMaterial[] = [];
  private geometries: THREE.BufferGeometry[] = [];

  private turtles: Turtle[] = [];
  private salience: EnvelopeFollower[] = [];
  private stemQueue: Stroke[] = [];
  private leafQueue: Stroke[] = [];
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

    this.createTarget();

    const quad = new THREE.PlaneGeometry(1, 1);
    this.stemMat = new THREE.ShaderMaterial({
      vertexShader: stemVertex,
      fragmentShader: stemFragment,
      uniforms: { uOpacity: { value: 0.92 } },
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    this.stems = new THREE.InstancedMesh(quad, this.stemMat, MAX_STEMS);
    this.stems.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_STEMS * 3),
      3,
    );
    this.stems.frustumCulled = false;
    this.stems.count = 0;

    this.leafMat = new THREE.ShaderMaterial({
      vertexShader: leafVertex,
      fragmentShader: leafFragment,
      uniforms: { uOpacity: { value: 0.9 } },
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    this.foliage = new THREE.InstancedMesh(quad, this.leafMat, MAX_FOLIAGE);
    this.foliage.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_FOLIAGE * 3),
      3,
    );
    this.foliage.frustumCulled = false;
    this.foliage.count = 0;
    this.strokeScene.add(this.stems, this.foliage);

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

      this.turtles.push(this.newShoot(0));
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

  private newShoot(pan: number): Turtle {
    return {
      x: clamp(
        pan * this.aspect * 0.7 + (this.rng() - 0.5) * this.aspect * 1.1,
        -this.aspect * 0.92,
        this.aspect * 0.92,
      ),
      y: -0.99,
      angle: Math.PI / 2 + (this.rng() - 0.5) * 0.5,
      kSlow: (this.rng() - 0.5) * 2,
      curlRemaining: 0,
      curlSign: 1,
      len: 0,
      maxLen: 1.2 + this.rng() * 1.1,
      leafAcc: 0.02 + this.rng() * 0.03,
      sinceBloom: this.rng() * 2,
      leafSide: this.rng() > 0.5 ? 1 : -1,
    };
  }

  private sowSoil(): void {
    for (let i = 0; i < 40; i++) {
      const t = i / 39;
      this.stemQueue.push({
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
      t.sinceBloom += dt;

      const tipMat = this.tipMats[b];
      tipMat.uniforms.uAspect.value = this.aspect;
      (tipMat.uniforms.uPos.value as THREE.Vector2).set(t.x / this.aspect, t.y);
      tipMat.uniforms.uScale.value = 0.015 + band.energy * 0.035 + sal * 0.02;
      tipMat.uniforms.uIntensity.value = band.energy * (0.35 + sal * 0.65);

      if (band.energy < 0.03 || !frame.playing) continue;

      // ---- vine motion: smooth curvature, arc-length based -----------------
      const step = band.energy * dt * (0.17 + sal * 0.06);

      // ornamented, busy playing occasionally throws a tendril curl
      if (t.curlRemaining <= 0 && this.rng() < (0.012 + frame.flux * 0.055) * dt * 10) {
        t.curlRemaining = 0.05 + this.rng() * 0.06;
        t.curlSign = this.rng() > 0.5 ? 1 : -1;
      }
      let k = t.kSlow;
      if (t.curlRemaining > 0) {
        t.curlRemaining -= step;
        k += t.curlSign * (24 + frame.flux * 14); // a deliberate little spiral
      } else {
        // pitch steers; the vine breathes side to side; verticality is home
        const kTarget =
          (band.pitch - 0.5) * 5 +
          Math.sin(this.time * (0.5 + b * 0.11) + b * 2.6) * (1.6 + frame.flux * 2.2);
        t.kSlow += (kTarget - t.kSlow) * Math.min(1, dt * 1.8);
        // lean back toward upright so vines climb rather than keel over
        const upright = Math.PI / 2 - t.angle;
        k += clamp(upright, -1.2, 1.2) * 2.2;
      }
      t.angle += k * step;

      const nx = t.x + Math.cos(t.angle) * step;
      const ny = t.y + Math.sin(t.angle) * step;
      t.len += step;
      t.leafAcc += step;

      // taper: thick at the root, fine at the growing tip
      const taper = 0.25 + 0.75 * (1 - t.len / t.maxLen);
      if (this.stemQueue.length < MAX_STEMS) {
        this.stemQueue.push({
          x: (t.x + nx) / 2,
          y: (t.y + ny) / 2,
          rot: t.angle,
          len: Math.max(step * 3, 0.012),
          width: (0.006 + band.energy * 0.014 + sal * 0.004) * taper,
          color: VOICE_COLORS[b]
            .clone()
            .offsetHSL(0, 0.04 * Math.sin(t.len * 9), 0.05 * Math.sin(t.len * 23) + sal * 0.07),
        });
      }
      t.x = nx;
      t.y = ny;

      // ---- foliage ---------------------------------------------------------
      const blooming =
        band.attackStrength > 0.55 && frame.energySlow > 0.62 && t.sinceBloom > BLOOM_COOLDOWN;
      if (blooming) {
        t.sinceBloom = 0;
        const petals = 6;
        const size = 0.03 + band.energy * 0.035;
        for (let p = 0; p < petals && this.leafQueue.length < MAX_FOLIAGE - 1; p++) {
          const a = (p / petals) * Math.PI * 2 + this.rng() * 0.3;
          this.leafQueue.push({
            x: t.x + Math.cos(a) * size * 0.55,
            y: t.y + Math.sin(a) * size * 0.55,
            rot: a,
            len: size * 1.7,
            width: size * 0.95,
            color: BLOOM_GOLD.clone().offsetHSL(0, 0, (this.rng() - 0.5) * 0.1),
          });
        }
        // flower heart
        this.stemQueue.push({
          x: t.x,
          y: t.y,
          rot: 0,
          len: size * 0.55,
          width: size * 0.55,
          color: BLOOM_HEART.clone(),
        });
      } else if (t.leafAcc > 0.13 && t.len > 0.06) {
        // generous leaves set sparsely along the climbing vine
        t.leafAcc = 0;
        t.leafSide *= -1;
        const leafLen = (0.045 + band.energy * 0.04) * (0.55 + 0.45 * (1 - t.len / t.maxLen));
        const la = t.angle + (Math.PI / 3.1) * t.leafSide + (this.rng() - 0.5) * 0.2;
        if (this.leafQueue.length < MAX_FOLIAGE) {
          this.leafQueue.push({
            x: t.x + Math.cos(la) * leafLen * 0.48,
            y: t.y + Math.sin(la) * leafLen * 0.48,
            rot: la,
            len: leafLen,
            width: leafLen * 0.55,
            color: LEAF_TINT.clone()
              .lerp(VOICE_COLORS[b], 0.3)
              .offsetHSL(0, 0.05, 0.04 + this.rng() * 0.05),
          });
        }
      }

      // shoot finished or off the page: a new vine rises where the voice is
      if (t.len > t.maxLen || t.y > 0.94 || Math.abs(t.x) > this.aspect * 0.96) {
        this.turtles[b] = this.newShoot(band.pan);
      }
    }

    this.paint();
    this.compositeMat.uniforms.uWarmth.value = clamp01(frame.energySlow * 1.2);
  }

  private fill(mesh: THREE.InstancedMesh, queue: Stroke[]): void {
    const n = queue.length;
    for (let i = 0; i < n; i++) {
      const d = queue[i];
      this.dummy.position.set(d.x, d.y, 0);
      this.dummy.rotation.set(0, 0, d.rot);
      this.dummy.scale.set(d.len, d.width, 1);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(i, this.dummy.matrix);
      mesh.setColorAt(i, d.color);
    }
    mesh.count = n;
    queue.length = 0;
    if (n > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  private paint(): void {
    if (!this.rt) return;
    const had = this.stemQueue.length + this.leafQueue.length;
    this.fill(this.stems, this.stemQueue);
    this.fill(this.foliage, this.leafQueue);
    if (had === 0 && !this.needsClear) return;

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
    for (let b = 0; b < BAND_COUNT; b++) this.turtles[b] = this.newShoot(0);
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
    this.stemMat.dispose();
    this.leafMat.dispose();
    this.compositeMat.dispose();
    for (const m of this.tipMats) m.dispose();
  }
}
