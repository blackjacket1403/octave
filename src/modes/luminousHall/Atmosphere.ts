import * as THREE from 'three';
import {
  AFTERGLOW_COLOR,
  HAZE_COOL,
  HAZE_WARM,
  SKY_BOTTOM,
  SKY_HORIZON_COOL,
  SKY_HORIZON_WARM,
  SKY_TOP,
} from './palette';

/**
 * Everything that makes the hall a place rather than a void: the gradient
 * dome, the glossy floor with its climax afterglow, drifting volumetric haze
 * billboards, and ambient dust motes. Density and warmth are driven by the
 * music; in silence the hall stays dimly alive.
 */

const HAZE_COUNT = 22;
const MOTE_COUNT = 720;

// ---------- sky dome ----------
const skyVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const skyFragment = /* glsl */ `
  uniform vec3 uBottom;
  uniform vec3 uHorizon;
  uniform vec3 uTop;
  uniform float uLift;
  varying vec3 vDir;
  void main() {
    float h = vDir.y;
    vec3 c = h < 0.0
      ? mix(uHorizon, uBottom, smoothstep(0.0, -0.45, h))
      : mix(uHorizon, uTop, smoothstep(0.0, 0.6, h));
    c *= 1.0 + uLift * 0.7;
    gl_FragColor = vec4(c, 1.0);
  }
`;

// ---------- floor ----------
const floorVertex = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const floorFragment = /* glsl */ `
  uniform vec3 uBase;
  uniform vec3 uGlowColor;
  uniform float uAfterglow;
  uniform float uWarmth;
  varying vec3 vWorld;
  void main() {
    float dist = length(vWorld.xz);
    // faint sheen near the stage, falling to black at the hall edges
    float sheen = exp(-dist * 0.055);
    vec3 c = uBase * (0.35 + sheen * 0.9);
    c = mix(c, c * vec3(1.25, 1.05, 0.8), uWarmth * 0.6);
    // afterglow: climaxes leave a slow-fading pool of warmth on the stage
    float g = exp(-pow(length(vWorld.xz - vec2(0.0, -7.0)) * 0.085, 2.0));
    c += uGlowColor * g * uAfterglow * 0.30;
    gl_FragColor = vec4(c, 1.0);
  }
`;

// ---------- haze billboards (instanced) ----------
const hazeVertex = /* glsl */ `
  uniform float uTime;
  attribute vec4 aData;  // xyz = anchor position, w = scale
  attribute float aPhase;
  varying vec2 vUv;
  varying float vSeed;
  void main() {
    vec3 anchor = aData.xyz;
    anchor.x += sin(uTime * 0.045 + aPhase * 6.28318) * 2.4;
    anchor.y += sin(uTime * 0.03 + aPhase * 12.6) * 0.9;
    anchor.z += cos(uTime * 0.04 + aPhase * 9.4) * 1.8;
    vec4 mv = modelViewMatrix * vec4(anchor, 1.0);
    float scale = aData.w * (1.0 + 0.12 * sin(uTime * 0.1 + aPhase * 20.0));
    mv.xy += position.xy * scale;
    vUv = uv;
    vSeed = aPhase;
    gl_Position = projectionMatrix * mv;
  }
`;

const hazeFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uDensity;
  varying vec2 vUv;
  varying float vSeed;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float a = exp(-d * d * 2.6) * uDensity * mix(0.5, 1.0, vSeed) * 0.05;
    if (a <= 0.002) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

// ---------- stage arc: a faint line of light grounding the strands ----------
const arcVertex = /* glsl */ `
  varying vec2 vSW; // x = 0..1 along arc, y = -1..1 across
  void main() {
    vSW = vec2(uv.x, uv.y * 2.0 - 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const arcFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  varying vec2 vSW;
  void main() {
    float across = exp(-vSW.y * vSW.y * 3.0);
    float ends = smoothstep(0.0, 0.12, vSW.x) * smoothstep(1.0, 0.88, vSW.x);
    float a = across * ends * uIntensity;
    if (a <= 0.002) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

/** Strip geometry tracing the orchestra arc on the floor. */
function buildArcGeometry(): THREE.BufferGeometry {
  const STEPS = 64;
  const RADIUS = 19.5;
  const HALF = 0.78; // radians, a little wider than the strand arc
  const WIDTH = 2.6;
  const ORIGIN_Z = 11;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const ang = -HALF + t * HALF * 2;
    for (const w of [-0.5, 0.5]) {
      const r = RADIUS + w * WIDTH;
      pos.push(Math.sin(ang) * r, 0.02, ORIGIN_Z - Math.cos(ang) * r);
      uv.push(t, w + 0.5);
    }
    if (i < STEPS) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// ---------- motes ----------
const moteVertex = /* glsl */ `
  uniform float uTime;
  uniform float uPx;
  attribute vec3 aSeed;
  attribute float aPhase;
  varying float vFade;
  void main() {
    vec3 base = vec3(
      (aSeed.x - 0.5) * 44.0,
      aSeed.y * 12.0 + 0.4,
      aSeed.z * -30.0 + 8.0
    );
    base += vec3(
      sin(uTime * 0.06 + aPhase * 6.28318),
      sin(uTime * 0.045 + aPhase * 14.0) * 0.7,
      cos(uTime * 0.05 + aPhase * 9.0)
    ) * 1.6;
    vec4 mv = modelViewMatrix * vec4(base, 1.0);
    gl_PointSize = mix(1.5, 3.4, aPhase) * uPx * (300.0 / max(1.0, -mv.z));
    vFade = mix(0.3, 1.0, fract(aPhase * 7.31));
    // slow individual twinkle, far below flicker speed
    vFade *= 0.6 + 0.4 * sin(uTime * mix(0.2, 0.55, aSeed.x) + aPhase * 40.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const moteFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uDensity;
  varying float vFade;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv) * 2.0;
    float a = exp(-d * d * 4.0) * vFade * uDensity * 0.18;
    if (a <= 0.003) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

export class Atmosphere {
  readonly group = new THREE.Group();
  private skyMat: THREE.ShaderMaterial;
  private floorMat: THREE.ShaderMaterial;
  private hazeMat: THREE.ShaderMaterial;
  private moteMat: THREE.ShaderMaterial;
  private arcMat: THREE.ShaderMaterial;
  private moteGeo: THREE.BufferGeometry;
  private hazeGeo: THREE.InstancedBufferGeometry;
  private disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  private horizonCool = SKY_HORIZON_COOL.clone();
  private horizonWarm = SKY_HORIZON_WARM.clone();

  constructor(rng: () => number) {
    // sky dome
    const skyGeo = new THREE.SphereGeometry(180, 24, 16);
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      uniforms: {
        uBottom: { value: SKY_BOTTOM.clone() },
        uHorizon: { value: SKY_HORIZON_COOL.clone() },
        uTop: { value: SKY_TOP.clone() },
        uLift: { value: 0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
    });
    const sky = new THREE.Mesh(skyGeo, this.skyMat);
    sky.renderOrder = -10;
    sky.frustumCulled = false;

    // floor
    const floorGeo = new THREE.CircleGeometry(120, 48);
    this.floorMat = new THREE.ShaderMaterial({
      vertexShader: floorVertex,
      fragmentShader: floorFragment,
      uniforms: {
        uBase: { value: new THREE.Color('#0c0d15') },
        uGlowColor: { value: AFTERGLOW_COLOR.clone() },
        uAfterglow: { value: 0 },
        uWarmth: { value: 0 },
      },
      depthWrite: true,
    });
    const floor = new THREE.Mesh(floorGeo, this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    floor.renderOrder = -9;

    // stage arc
    const arcGeo = buildArcGeometry();
    this.arcMat = new THREE.ShaderMaterial({
      vertexShader: arcVertex,
      fragmentShader: arcFragment,
      uniforms: {
        uColor: { value: new THREE.Color('#c8a96a') },
        uIntensity: { value: 0.05 },
      },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const arc = new THREE.Mesh(arcGeo, this.arcMat);
    arc.frustumCulled = false;

    // haze
    const plane = new THREE.PlaneGeometry(1, 1);
    this.hazeGeo = new THREE.InstancedBufferGeometry();
    this.hazeGeo.index = plane.index;
    this.hazeGeo.attributes.position = plane.attributes.position;
    this.hazeGeo.attributes.uv = plane.attributes.uv;
    const hazeData = new Float32Array(HAZE_COUNT * 4);
    const hazePhase = new Float32Array(HAZE_COUNT);
    for (let i = 0; i < HAZE_COUNT; i++) {
      hazeData[i * 4] = (rng() - 0.5) * 38;
      hazeData[i * 4 + 1] = 1.5 + rng() * 9;
      hazeData[i * 4 + 2] = 4 - rng() * 26;
      hazeData[i * 4 + 3] = 9 + rng() * 14; // scale
      hazePhase[i] = rng();
    }
    this.hazeGeo.setAttribute('aData', new THREE.InstancedBufferAttribute(hazeData, 4));
    this.hazeGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(hazePhase, 1));
    this.hazeGeo.instanceCount = HAZE_COUNT;
    this.hazeGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.hazeMat = new THREE.ShaderMaterial({
      vertexShader: hazeVertex,
      fragmentShader: hazeFragment,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: HAZE_COOL.clone() },
        uDensity: { value: 0.4 },
      },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const haze = new THREE.Mesh(this.hazeGeo, this.hazeMat);
    haze.frustumCulled = false;

    // motes
    this.moteGeo = new THREE.BufferGeometry();
    const mPos = new Float32Array(MOTE_COUNT * 3);
    const mSeed = new Float32Array(MOTE_COUNT * 3);
    const mPhase = new Float32Array(MOTE_COUNT);
    for (let i = 0; i < MOTE_COUNT; i++) {
      mSeed[i * 3] = rng();
      mSeed[i * 3 + 1] = rng();
      mSeed[i * 3 + 2] = rng();
      mPhase[i] = rng();
    }
    this.moteGeo.setAttribute('position', new THREE.BufferAttribute(mPos, 3));
    this.moteGeo.setAttribute('aSeed', new THREE.BufferAttribute(mSeed, 3));
    this.moteGeo.setAttribute('aPhase', new THREE.BufferAttribute(mPhase, 1));
    this.moteGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.moteMat = new THREE.ShaderMaterial({
      vertexShader: moteVertex,
      fragmentShader: moteFragment,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color('#cdbf9e') },
        uDensity: { value: 0.5 },
        uPx: { value: 1 },
      },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const motes = new THREE.Points(this.moteGeo, this.moteMat);
    motes.frustumCulled = false;

    this.group.add(sky, floor, arc, haze, motes);
    this.disposables.push(skyGeo, floorGeo, arcGeo, plane, this.hazeGeo, this.moteGeo);
    this.disposables.push(this.skyMat, this.floorMat, this.hazeMat, this.moteMat, this.arcMat);
  }

  /**
   * @param warmth    0..1 slow integral of loudness — cool hall to warm hall
   * @param density   0..1 texture density (flux + active band count)
   * @param afterglow 0..1 fading memory of the last climax
   * @param lift      fast total energy, lifts the dome slightly on swells
   */
  update(
    time: number,
    warmth: number,
    density: number,
    afterglow: number,
    lift: number,
    px = 1,
  ): void {
    this.hazeMat.uniforms.uTime.value = time;
    this.moteMat.uniforms.uTime.value = time;
    this.moteMat.uniforms.uPx.value = px;

    (this.skyMat.uniforms.uHorizon.value as THREE.Color)
      .copy(this.horizonCool)
      .lerp(this.horizonWarm, warmth);
    this.skyMat.uniforms.uLift.value = lift * 0.45 + warmth * 0.25;

    (this.hazeMat.uniforms.uColor.value as THREE.Color).copy(HAZE_COOL).lerp(HAZE_WARM, warmth);
    // never fully empty: the dormant hall keeps a breath of haze
    this.hazeMat.uniforms.uDensity.value = 0.3 + density * 0.85;
    this.moteMat.uniforms.uDensity.value = 0.3 + density * 1.05;

    this.floorMat.uniforms.uAfterglow.value = afterglow;
    this.floorMat.uniforms.uWarmth.value = warmth;

    // the stage line breathes with the music but never disappears
    this.arcMat.uniforms.uIntensity.value = 0.035 + lift * 0.08 + warmth * 0.05;
  }

  setQuality(level: number): void {
    this.hazeGeo.instanceCount = level >= 2 ? HAZE_COUNT : level === 1 ? 12 : 6;
    const motes = level >= 2 ? MOTE_COUNT : level === 1 ? MOTE_COUNT / 2 : MOTE_COUNT / 4;
    this.moteGeo.setDrawRange(0, motes);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
