import * as THREE from 'three';
import type { Mode } from '../Mode';
import type { AnalysisFrame } from '../../audio/analysis';
import { BAND_COUNT } from '../../audio/analysis';
import { EnvelopeFollower, clamp, clamp01, lerp, smoothK } from '../../audio/smoothing';
import { TrailRibbon } from '../shared/TrailRibbon';
import { BAND_COLORS, DIM_COLOR } from '../luminousHall/palette';

/**
 * Mode 4 — Celestial Mechanics.
 * A living spiral galaxy seen from just above its plane. The disk itself
 * plays: its rotation, shimmer and core fire follow the music. The five
 * voices are blazing comet-stars swooping around the core with long light
 * trails — pitch lifts them off the plane, stereo sets their bearing,
 * loudness draws them in toward the burning heart. Fast figuration
 * (Vivaldi!) makes the arms glitter and births showers of new stars;
 * climaxes flare the core; quiet recedes into slow, cold turning.
 */

const GALAXY_STARS = 14000;
const FAR_STARS = 700;
const NEBULA_COUNT = 16;
const SPARK_CAP = 256;
const SPARK_LIFE = 1.7;

const GALAXY_TILT = 0.46;
const ELEV_BASE = [0.8, 1.7, 2.6, 3.5, 4.4]; // height above the disk
const ORBIT_DIR = [1, 1, -1, 1, -1]; // brilliance & alto run retrograde

// ---------------------------------------------------------------------------
// shaders
// ---------------------------------------------------------------------------

const galaxyVertex = /* glsl */ `
  uniform float uTime;
  uniform float uRot;
  uniform float uPx;
  uniform float uGlow;
  uniform float uFlux;
  attribute float aR;
  attribute float aTheta;
  attribute float aY;
  attribute vec3 aTint;
  attribute float aSize;
  attribute float aSeed;
  varying vec3 vColor;
  varying float vA;
  void main() {
    // differential rotation: the inner disk turns faster, arms wind forever
    float th = aTheta + uRot * (16.0 / (aR + 7.0));
    vec3 p = vec3(cos(th) * aR, aY, sin(th) * aR);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aSize * uPx * (300.0 / max(1.0, -mv.z));
    float tw = 0.6 + 0.4 * sin(uTime * (0.25 + aSeed * 1.1) + aSeed * 47.0);
    // busy music makes the arms glitter
    float glitter = 1.0 + uFlux * (0.5 + 0.9 * sin(uTime * 3.4 + aSeed * 91.0));
    vA = tw * glitter * uGlow;
    vColor = aTint;
    gl_Position = projectionMatrix * mv;
  }
`;

const galaxyFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vA;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv) * 2.0;
    float a = (exp(-d * d * 5.0) - 0.02) * vA;
    if (a <= 0.003) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

const farStarVertex = /* glsl */ `
  uniform float uTime;
  uniform float uPx;
  attribute float aMag;
  attribute float aPhase;
  varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = mix(0.7, 1.8, aMag) * uPx * (300.0 / max(1.0, -mv.z));
    vA = mix(0.12, 0.5, aMag) * (0.7 + 0.3 * sin(uTime * mix(0.1, 0.35, aMag) + aPhase * 40.0));
    gl_Position = projectionMatrix * mv;
  }
`;

const coreVertex = /* glsl */ `
  uniform float uScale;
  varying vec2 vUv;
  void main() {
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * uScale;
    vUv = uv;
    gl_Position = projectionMatrix * mv;
  }
`;

const coreFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uHot;
  uniform float uIntensity;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float halo = exp(-d * d * 3.2) * 0.35;
    float heart = exp(-d * d * 14.0) * 0.85;
    float a = (halo + heart) * uIntensity;
    if (a <= 0.004) discard;
    vec3 c = mix(uColor, uHot, exp(-d * d * 10.0));
    gl_FragColor = vec4(c, a);
  }
`;

const nebulaVertex = /* glsl */ `
  uniform float uTime;
  uniform float uRot;
  attribute vec4 aData;  // x = radius, y = theta0, z = height, w = scale
  attribute vec3 aTint;
  attribute float aPhase;
  varying vec2 vUv;
  varying vec3 vTint;
  varying float vSeed;
  void main() {
    float th = aData.y + uRot * (16.0 / (aData.x + 7.0));
    vec3 anchor = vec3(cos(th) * aData.x, aData.z, sin(th) * aData.x);
    vec4 mv = modelViewMatrix * vec4(anchor, 1.0);
    float scale = aData.w * (1.0 + 0.1 * sin(uTime * 0.12 + aPhase * 20.0));
    mv.xy += position.xy * scale;
    vUv = uv;
    vTint = aTint;
    vSeed = aPhase;
    gl_Position = projectionMatrix * mv;
  }
`;

const nebulaFragment = /* glsl */ `
  uniform float uDensity;
  varying vec2 vUv;
  varying vec3 vTint;
  varying float vSeed;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float a = exp(-d * d * 2.8) * uDensity * mix(0.4, 1.0, vSeed) * 0.07;
    if (a <= 0.002) discard;
    gl_FragColor = vec4(vTint, a);
  }
`;

const bodyVertex = /* glsl */ `
  uniform vec3 uCenter;
  uniform float uScale;
  varying vec2 vUv;
  void main() {
    vec4 mv = modelViewMatrix * vec4(uCenter, 1.0);
    mv.xy += position.xy * uScale;
    vUv = uv;
    gl_Position = projectionMatrix * mv;
  }
`;

const bodyFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uFlare;
  varying vec2 vUv;
  void main() {
    vec2 c = vUv - 0.5;
    float d = length(c) * 2.0;
    float ang = atan(c.y, c.x);
    float core = exp(-d * d * 26.0) * 1.3;
    float halo = exp(-d * d * 4.5) * 0.32;
    // four-ray diffraction spikes, sharpened by attacks
    float spikes = pow(abs(cos(ang * 2.0)), 36.0) * exp(-d * 2.6) * (0.35 + uFlare * 1.1);
    float a = (core + halo + spikes) * uIntensity;
    if (a <= 0.004) discard;
    gl_FragColor = vec4(uColor * (1.0 + uFlare * 0.5), a);
  }
`;

const sparkVertex = /* glsl */ `
  uniform float uTime;
  uniform float uPx;
  attribute vec3 aOrigin;
  attribute vec3 aVel;
  attribute float aBirth;
  attribute vec3 aColor;
  varying vec3 vColor;
  varying float vA;
  void main() {
    float age = uTime - aBirth;
    float t = clamp(age / ${SPARK_LIFE.toFixed(2)}, 0.0, 1.0);
    vec3 p = aOrigin + aVel * age * (1.0 - t * 0.45);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float size = mix(3.2, 0.4, t);
    gl_PointSize = size * uPx * (300.0 / max(1.0, -mv.z));
    vA = age < 0.0 ? 0.0 : (1.0 - t) * (1.0 - t);
    vColor = aColor;
    gl_Position = projectionMatrix * mv;
  }
`;

const sparkFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vA;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv) * 2.0;
    float a = (exp(-d * d * 6.0) - 0.02) * vA;
    if (a <= 0.003) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

const skyVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const skyFragment = /* glsl */ `
  uniform float uLift;
  varying vec3 vDir;
  void main() {
    float h = clamp(vDir.y, -1.0, 1.0);
    vec3 deep = vec3(0.008, 0.009, 0.022);
    vec3 zenith = vec3(0.004, 0.004, 0.012);
    vec3 c = mix(deep, zenith, smoothstep(-0.4, 0.8, h));
    c *= 1.0 + uLift * 0.6 * exp(-(h - 0.05) * (h - 0.05) * 6.0);
    gl_FragColor = vec4(c, 1.0);
  }
`;

function additive(m: THREE.ShaderMaterial): THREE.ShaderMaterial {
  m.blending = THREE.AdditiveBlending;
  m.transparent = true;
  m.depthWrite = false;
  return m;
}

interface OrbitBody {
  azimuth: number;
  elevation: number;
  radius: number;
  mat: THREE.ShaderMaterial;
  trail: TrailRibbon;
  position: THREE.Vector3;
  salience: EnvelopeFollower;
  color: THREE.Color;
}

export class Celestial implements Mode {
  private scene!: THREE.Scene;
  private renderer!: THREE.WebGLRenderer;
  private camera!: THREE.PerspectiveCamera;
  private group = new THREE.Group(); // tilted galactic frame
  private root = new THREE.Group();
  private bodies: OrbitBody[] = [];

  private galaxyMat!: THREE.ShaderMaterial;
  private galaxyGeo!: THREE.BufferGeometry;
  private farMat!: THREE.ShaderMaterial;
  private coreMat!: THREE.ShaderMaterial;
  private coreHaloMat!: THREE.ShaderMaterial;
  private nebulaMat!: THREE.ShaderMaterial;
  private nebulaGeo!: THREE.InstancedBufferGeometry;
  private skyMat!: THREE.ShaderMaterial;
  private sparkMat!: THREE.ShaderMaterial;
  private sparkOrigin!: THREE.BufferAttribute;
  private sparkVel!: THREE.BufferAttribute;
  private sparkBirth!: THREE.BufferAttribute;
  private sparkColor!: THREE.BufferAttribute;
  private sparkCursor = 0;
  private disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  private time = 0;
  private rot = 0;
  private coreFlare = 0;
  private yaw = 0;
  private yawTarget = 0;
  private pitchLean = 0;
  private pitchLeanTarget = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private lookTargetYaw = 0;
  private lookTargetPitch = 0;
  private aspect = 16 / 9;
  private savedFov = 55;
  private euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private scratch = new THREE.Vector3();

  init(scene: THREE.Scene, renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    this.savedFov = camera.fov;
    this.aspect = camera.aspect;
    camera.fov = this.aspect < 1 ? 84 : 62;
    camera.position.set(0, 7.5, 26);
    camera.updateProjectionMatrix();

    this.group.rotation.x = GALAXY_TILT;

    let s = 0x9e3779b9;
    const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);

    // ---- deep sky + far stars ----
    const skyGeo = new THREE.SphereGeometry(170, 24, 16);
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      uniforms: { uLift: { value: 0 } },
      side: THREE.BackSide,
      depthWrite: false,
    });
    const sky = new THREE.Mesh(skyGeo, this.skyMat);
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    this.root.add(sky);

    const farGeo = new THREE.BufferGeometry();
    const fp = new Float32Array(FAR_STARS * 3);
    const fm = new Float32Array(FAR_STARS);
    const fph = new Float32Array(FAR_STARS);
    for (let i = 0; i < FAR_STARS; i++) {
      const az = rng() * Math.PI * 2;
      const el = Math.asin(rng() * 2 - 1);
      fp[i * 3] = Math.cos(el) * Math.sin(az) * 140;
      fp[i * 3 + 1] = Math.sin(el) * 140;
      fp[i * 3 + 2] = Math.cos(el) * Math.cos(az) * 140;
      fm[i] = Math.pow(rng(), 2.4);
      fph[i] = rng();
    }
    farGeo.setAttribute('position', new THREE.BufferAttribute(fp, 3));
    farGeo.setAttribute('aMag', new THREE.BufferAttribute(fm, 1));
    farGeo.setAttribute('aPhase', new THREE.BufferAttribute(fph, 1));
    this.farMat = additive(
      new THREE.ShaderMaterial({
        vertexShader: farStarVertex,
        fragmentShader: galaxyFragment.replace('varying vec3 vColor;', 'const vec3 vColor = vec3(0.78, 0.82, 0.92);'),
        uniforms: { uTime: { value: 0 }, uPx: { value: 1 } },
      }),
    );
    const far = new THREE.Points(farGeo, this.farMat);
    far.frustumCulled = false;
    this.root.add(far);

    // ---- the spiral disk ----
    this.galaxyGeo = new THREE.BufferGeometry();
    const gR = new Float32Array(GALAXY_STARS);
    const gTh = new Float32Array(GALAXY_STARS);
    const gY = new Float32Array(GALAXY_STARS);
    const gTint = new Float32Array(GALAXY_STARS * 3);
    const gSize = new Float32Array(GALAXY_STARS);
    const gSeed = new Float32Array(GALAXY_STARS);
    const cWarm = new THREE.Color('#ecc88f');
    const cBlue = new THREE.Color('#9db8e8');
    const cWhite = new THREE.Color('#e8e4da');
    const cRose = new THREE.Color('#c08a96');
    const tmp = new THREE.Color();
    const ARMS = 3;
    for (let i = 0; i < GALAXY_STARS; i++) {
      const u = rng();
      const r = 3.5 + Math.pow(u, 1.3) * 62; // dense centre, long reaching arms
      const arm = Math.floor(rng() * ARMS);
      const winding = Math.log(r + 4.0) * 2.4;
      const spread = 0.16 + (r / 64) * 0.55; // arms blur outward
      const theta =
        (arm / ARMS) * Math.PI * 2 + winding + (rng() + rng() - 1) * spread * Math.PI;
      const thick = Math.max(0.35, 2.4 - r * 0.035);
      gR[i] = r;
      gTh[i] = theta;
      gY[i] = (rng() + rng() + rng() - 1.5) * thick;
      const t = clamp01((r - 4) / 55);
      tmp.copy(cWarm).lerp(rng() < 0.12 ? cRose : cBlue, Math.pow(t, 0.7));
      if (rng() < 0.08) tmp.copy(cWhite);
      gTint[i * 3] = tmp.r;
      gTint[i * 3 + 1] = tmp.g;
      gTint[i * 3 + 2] = tmp.b;
      gSize[i] = (0.42 + Math.pow(rng(), 3.0) * 1.6) * (1.3 - t * 0.4);
      gSeed[i] = rng();
    }
    // position attr required by three even though the shader rebuilds it
    this.galaxyGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(GALAXY_STARS * 3), 3));
    this.galaxyGeo.setAttribute('aR', new THREE.BufferAttribute(gR, 1));
    this.galaxyGeo.setAttribute('aTheta', new THREE.BufferAttribute(gTh, 1));
    this.galaxyGeo.setAttribute('aY', new THREE.BufferAttribute(gY, 1));
    this.galaxyGeo.setAttribute('aTint', new THREE.BufferAttribute(gTint, 3));
    this.galaxyGeo.setAttribute('aSize', new THREE.BufferAttribute(gSize, 1));
    this.galaxyGeo.setAttribute('aSeed', new THREE.BufferAttribute(gSeed, 1));
    this.galaxyGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.galaxyMat = additive(
      new THREE.ShaderMaterial({
        vertexShader: galaxyVertex,
        fragmentShader: galaxyFragment,
        uniforms: {
          uTime: { value: 0 },
          uRot: { value: 0 },
          uPx: { value: 1 },
          uGlow: { value: 0.5 },
          uFlux: { value: 0 },
        },
      }),
    );
    const disk = new THREE.Points(this.galaxyGeo, this.galaxyMat);
    disk.frustumCulled = false;
    this.group.add(disk);

    // ---- galactic core ----
    const coreGeo = new THREE.PlaneGeometry(1, 1);
    const makeCore = (scale: number, hot: string, color: string) =>
      additive(
        new THREE.ShaderMaterial({
          vertexShader: coreVertex,
          fragmentShader: coreFragment,
          uniforms: {
            uScale: { value: scale },
            uColor: { value: new THREE.Color(color) },
            uHot: { value: new THREE.Color(hot) },
            uIntensity: { value: 0.3 },
          },
        }),
      );
    this.coreMat = makeCore(10, '#fff3da', '#eec888');
    this.coreHaloMat = makeCore(30, '#e8cfa0', '#a88c5e');
    const core = new THREE.Mesh(coreGeo, this.coreMat);
    const coreHalo = new THREE.Mesh(coreGeo, this.coreHaloMat);
    core.frustumCulled = false;
    coreHalo.frustumCulled = false;
    this.group.add(coreHalo, core);

    // ---- nebulae riding the arms ----
    const plane = new THREE.PlaneGeometry(1, 1);
    this.nebulaGeo = new THREE.InstancedBufferGeometry();
    this.nebulaGeo.index = plane.index;
    this.nebulaGeo.attributes.position = plane.attributes.position;
    this.nebulaGeo.attributes.uv = plane.attributes.uv;
    const nd = new Float32Array(NEBULA_COUNT * 4);
    const nt = new Float32Array(NEBULA_COUNT * 3);
    const np = new Float32Array(NEBULA_COUNT);
    const nebTints = [new THREE.Color('#5868a8'), new THREE.Color('#4a8a8c'), new THREE.Color('#a06a7c')];
    for (let i = 0; i < NEBULA_COUNT; i++) {
      const r = 10 + rng() * 42;
      nd[i * 4] = r;
      nd[i * 4 + 1] = rng() * Math.PI * 2;
      nd[i * 4 + 2] = (rng() - 0.5) * 2.5;
      nd[i * 4 + 3] = 8 + rng() * 13;
      const c = nebTints[i % 3];
      nt[i * 3] = c.r;
      nt[i * 3 + 1] = c.g;
      nt[i * 3 + 2] = c.b;
      np[i] = rng();
    }
    this.nebulaGeo.setAttribute('aData', new THREE.InstancedBufferAttribute(nd, 4));
    this.nebulaGeo.setAttribute('aTint', new THREE.InstancedBufferAttribute(nt, 3));
    this.nebulaGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(np, 1));
    this.nebulaGeo.instanceCount = NEBULA_COUNT;
    this.nebulaGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.nebulaMat = additive(
      new THREE.ShaderMaterial({
        vertexShader: nebulaVertex,
        fragmentShader: nebulaFragment,
        uniforms: {
          uTime: { value: 0 },
          uRot: { value: 0 },
          uDensity: { value: 0.5 },
        },
      }),
    );
    const nebula = new THREE.Mesh(this.nebulaGeo, this.nebulaMat);
    nebula.frustumCulled = false;
    this.group.add(nebula);

    // ---- star-birth sparks ----
    const sparkGeo = new THREE.BufferGeometry();
    this.sparkOrigin = new THREE.BufferAttribute(new Float32Array(SPARK_CAP * 3), 3);
    this.sparkVel = new THREE.BufferAttribute(new Float32Array(SPARK_CAP * 3), 3);
    this.sparkBirth = new THREE.BufferAttribute(new Float32Array(SPARK_CAP).fill(-100), 1);
    this.sparkColor = new THREE.BufferAttribute(new Float32Array(SPARK_CAP * 3), 3);
    for (const a of [this.sparkOrigin, this.sparkVel, this.sparkBirth, this.sparkColor]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    sparkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARK_CAP * 3), 3));
    sparkGeo.setAttribute('aOrigin', this.sparkOrigin);
    sparkGeo.setAttribute('aVel', this.sparkVel);
    sparkGeo.setAttribute('aBirth', this.sparkBirth);
    sparkGeo.setAttribute('aColor', this.sparkColor);
    sparkGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.sparkMat = additive(
      new THREE.ShaderMaterial({
        vertexShader: sparkVertex,
        fragmentShader: sparkFragment,
        uniforms: { uTime: { value: 0 }, uPx: { value: 1 } },
      }),
    );
    const sparks = new THREE.Points(sparkGeo, this.sparkMat);
    sparks.frustumCulled = false;
    this.group.add(sparks);

    // ---- the five voices ----
    const bodyGeo = new THREE.PlaneGeometry(1, 1);
    for (let b = 0; b < BAND_COUNT; b++) {
      const mat = additive(
        new THREE.ShaderMaterial({
          vertexShader: bodyVertex,
          fragmentShader: bodyFragment,
          uniforms: {
            uCenter: { value: new THREE.Vector3() },
            uScale: { value: 1.2 },
            uColor: { value: BAND_COLORS[b].clone() },
            uIntensity: { value: 0.1 },
            uFlare: { value: 0 },
          },
        }),
      );
      const mesh = new THREE.Mesh(bodyGeo, mat);
      mesh.frustumCulled = false;
      const trail = new TrailRibbon(96, 0.04);
      const body: OrbitBody = {
        azimuth: (b / BAND_COUNT) * Math.PI * 2,
        elevation: ELEV_BASE[b],
        radius: 17,
        mat,
        trail,
        position: new THREE.Vector3(),
        salience: new EnvelopeFollower(600, 1600),
        color: BAND_COLORS[b].clone(),
      };
      this.orbitToPosition(body);
      trail.reset(body.position, 0);
      this.group.add(mesh, trail.mesh);
      this.bodies.push(body);
    }

    this.root.add(this.group);
    scene.add(this.root);
    this.disposables.push(
      skyGeo, farGeo, this.galaxyGeo, coreGeo, plane, this.nebulaGeo, sparkGeo, bodyGeo,
      this.skyMat, this.farMat, this.galaxyMat, this.coreMat, this.coreHaloMat,
      this.nebulaMat, this.sparkMat,
    );
  }

  private orbitToPosition(b: OrbitBody): void {
    b.position.set(
      Math.cos(b.azimuth) * b.radius,
      b.elevation,
      Math.sin(b.azimuth) * b.radius,
    );
  }

  private burst(body: OrbitBody, strength: number): void {
    const n = 5 + Math.floor(strength * 9);
    for (let i = 0; i < n; i++) {
      const k = this.sparkCursor;
      this.sparkCursor = (this.sparkCursor + 1) % SPARK_CAP;
      this.sparkOrigin.setXYZ(
        k,
        body.position.x + (Math.random() - 0.5) * 0.6,
        body.position.y + (Math.random() - 0.5) * 0.6,
        body.position.z + (Math.random() - 0.5) * 0.6,
      );
      const sp = 1.2 + Math.random() * 2.8 * (0.5 + strength);
      const az = Math.random() * Math.PI * 2;
      const el = (Math.random() - 0.5) * Math.PI;
      this.sparkVel.setXYZ(
        k,
        Math.cos(el) * Math.cos(az) * sp,
        Math.sin(el) * sp * 0.7,
        Math.cos(el) * Math.sin(az) * sp,
      );
      this.sparkBirth.setX(k, this.time);
      this.sparkColor.setXYZ(k, body.color.r, body.color.g, body.color.b);
    }
    this.sparkOrigin.needsUpdate = true;
    this.sparkVel.needsUpdate = true;
    this.sparkBirth.needsUpdate = true;
    this.sparkColor.needsUpdate = true;
  }

  update(frame: AnalysisFrame, dt: number): void {
    this.time += dt;
    const dtMs = dt * 1000;
    const px = this.renderer.getPixelRatio();

    // the whole disk turns with the music's sustained energy
    this.rot += dt * (0.012 + frame.energySlow * 0.085 + frame.energyFast * 0.02);

    const gu = this.galaxyMat.uniforms;
    gu.uTime.value = this.time;
    gu.uRot.value = this.rot;
    gu.uPx.value = px;
    gu.uGlow.value = 0.4 + frame.energySlow * 0.55 + frame.energyFast * 0.25;
    gu.uFlux.value = frame.flux;

    this.farMat.uniforms.uTime.value = this.time;
    this.farMat.uniforms.uPx.value = px;
    this.skyMat.uniforms.uLift.value = frame.energySlow * 0.8;

    // core: breathes with the swell, flares on heavy onsets
    this.coreFlare = Math.max(
      this.coreFlare * Math.exp(-dt / 0.9),
      frame.onset * clamp01(frame.energySlow * 1.4),
    );
    this.coreMat.uniforms.uIntensity.value = 0.22 + frame.energySlow * 0.7 + this.coreFlare * 0.9;
    this.coreMat.uniforms.uScale.value = 9 + frame.energySlow * 5 + this.coreFlare * 3;
    this.coreHaloMat.uniforms.uIntensity.value = 0.10 + frame.energySlow * 0.3 + this.coreFlare * 0.3;

    const nu = this.nebulaMat.uniforms;
    nu.uTime.value = this.time;
    nu.uRot.value = this.rot;
    nu.uDensity.value = 0.3 + frame.flux * 0.8 + (frame.activeBands / BAND_COUNT) * 0.4;

    this.sparkMat.uniforms.uTime.value = this.time;
    this.sparkMat.uniforms.uPx.value = px;

    // ---- voices ----
    let leanAz = 0;
    let leanWeight = 0;
    for (let b = 0; b < BAND_COUNT; b++) {
      const band = frame.bands[b];
      const body = this.bodies[b];
      const salient = body.salience.process(
        frame.salientBand === b ? frame.salience : 0,
        dtMs,
      );

      // swooping orbits: loud passages fly, quiet ones drift
      body.azimuth += dt * ORBIT_DIR[b] * (0.06 + band.energy * 0.85 + salient * 0.25);

      // stereo bearing: the camera sits at +z looking at the core, so
      // screen-left is azimuth π, screen-right azimuth 0; a loud panned
      // voice is gently held on its side of the sky
      const azTarget = Math.PI / 2 - band.pan * 1.25;
      const panTrust = clamp01(band.energy * 3) * 0.6;
      let azErr = azTarget - body.azimuth;
      azErr = Math.atan2(Math.sin(azErr), Math.cos(azErr));
      body.azimuth += azErr * smoothK(2200, dtMs) * panTrust;

      const elevTarget =
        ELEV_BASE[b] + (band.pitch - 0.5) * 2.2 + Math.sin(this.time * 0.4 + b) * 0.3;
      body.elevation += (elevTarget - body.elevation) * smoothK(1200, dtMs);

      // loudness draws the voice in toward the burning core
      const radTarget = lerp(20, 9, clamp01(band.energy * 1.15));
      body.radius += (radTarget - body.radius) * smoothK(900, dtMs);
      this.orbitToPosition(body);

      body.color.copy(BAND_COLORS[b]).lerp(DIM_COLOR, (1 - salient) * frame.salience * 0.3);

      const intensity = Math.min(
        1.05,
        0.08 + Math.pow(band.energy, 1.15) * 0.8 * (1 + salient * 0.7),
      );
      const u = body.mat.uniforms;
      (u.uCenter.value as THREE.Vector3).copy(body.position);
      u.uScale.value = (1.1 + band.energy * 2.4) * (1 + salient * 0.5);
      (u.uColor.value as THREE.Color).copy(body.color);
      u.uIntensity.value = intensity;
      u.uFlare.value = band.attackStrength;

      body.trail.update(
        this.time,
        body.position,
        body.color,
        (0.18 + band.energy * 0.7) * (0.6 + salient * 0.9),
        0.008 + band.energy * 0.013 + salient * 0.008,
        this.aspect,
      );

      // figuration showers the arms with newborn stars
      if (band.attack && band.attackStrength > 0.14) {
        this.burst(body, band.attackStrength);
      }

      if (salient > leanWeight) {
        leanWeight = salient;
        // where is this body on screen? lean the camera toward it
        this.scratch.copy(body.position);
        this.group.localToWorld(this.scratch);
        leanAz = Math.atan2(this.scratch.x, -(this.scratch.z - this.camera.position.z) + 1e-4);
      }
    }

    // ---- camera: slow gaze following the melody around the galaxy ----
    this.yawTarget = clamp(-leanAz * 0.5, -0.5, 0.5) * leanWeight;
    this.pitchLeanTarget = leanWeight * 0.06;
    this.yaw += (this.yawTarget - this.yaw) * smoothK(2800, dtMs);
    this.pitchLean += (this.pitchLeanTarget - this.pitchLean) * smoothK(2800, dtMs);
    const kLook = smoothK(400, dtMs);
    this.lookYaw += (this.lookTargetYaw - this.lookYaw) * kLook;
    this.lookPitch += (this.lookTargetPitch - this.lookPitch) * kLook;

    this.camera.position.set(
      Math.sin(this.time * (Math.PI * 2 / 31)) * 0.5,
      7.5 + Math.sin(this.time * (Math.PI * 2 / 23)) * 0.4,
      26 + Math.sin(this.time * (Math.PI * 2 / 41)) * 0.8,
    );
    this.euler.set(
      -0.21 + this.pitchLean + this.lookPitch + Math.sin(this.time * (Math.PI * 2 / 17)) * 0.008,
      this.yaw + this.lookYaw,
      Math.sin(this.time * (Math.PI * 2 / 37)) * 0.004,
    );
    this.camera.quaternion.setFromEuler(this.euler);
  }

  resize(w: number, h: number): void {
    this.aspect = w / h;
    this.camera.fov = this.aspect < 1 ? 84 : 62;
    this.camera.updateProjectionMatrix();
  }

  setQuality(level: number): void {
    const stars = level >= 2 ? GALAXY_STARS : level === 1 ? 8000 : 4500;
    this.galaxyGeo.setDrawRange(0, stars);
    this.nebulaGeo.instanceCount = level >= 2 ? NEBULA_COUNT : level === 1 ? 10 : 6;
  }

  setLook(x: number, y: number): void {
    this.lookTargetYaw = clamp(x, -1, 1) * THREE.MathUtils.degToRad(40);
    this.lookTargetPitch = clamp(y, -1, 1) * THREE.MathUtils.degToRad(22);
  }

  dispose(): void {
    this.scene.remove(this.root);
    for (const d of this.disposables) d.dispose();
    for (const b of this.bodies) {
      b.mat.dispose();
      b.trail.dispose();
    }
    this.bodies = [];
    this.camera.fov = this.savedFov;
    this.camera.position.set(0, 2.5, 9.5);
    this.camera.rotation.set(0, 0, 0);
    this.camera.updateProjectionMatrix();
  }
}
