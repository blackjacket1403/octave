import * as THREE from 'three';
import type { Mode } from '../Mode';
import type { AnalysisFrame } from '../../audio/analysis';
import { BAND_COUNT } from '../../audio/analysis';
import { EnvelopeFollower, clamp, clamp01, lerp, smoothK } from '../../audio/smoothing';
import { TrailRibbon } from '../shared/TrailRibbon';
import { BAND_COLORS, DIM_COLOR } from '../luminousHall/palette';

/**
 * Mode 5 — The Voyage.
 * You fly forward through deep space. The five voices are silk ribbons of
 * light streaming alongside you, undulating with their music and slaloming
 * around the star systems you pass. Every star is tuned to one voice: it
 * pulses with that voice's loudness and its planets revolve faster the
 * harder that voice plays. Onsets burst sparks from the ribbon heads; the
 * melody's ribbon blazes and pulls your gaze; a climax throws the whole
 * voyage into speed.
 */

const STREAM_STARS = 2600;
const CORRIDOR = { x: 46, y: 30, depth: 170 }; // wrapping starfield volume
const SYSTEM_COUNT = 8;
const PLANETS_PER = 4;
const SPARK_CAP = 192;
const SPARK_LIFE = 1.5;
const RIBBON_HOME_X = [10, 5.5, 0, -6, -11]; // default lanes (violins left)
const RIBBON_HOME_Y = [-6.5, -3, 0.5, 4, 7.5];

// ---------------------------------------------------------------------------
// shaders
// ---------------------------------------------------------------------------

const streamVertex = /* glsl */ `
  uniform float uTravel;  // accumulated forward distance
  uniform float uTime;
  uniform float uPx;
  attribute vec3 aPos;
  attribute float aMag;
  attribute float aPhase;
  attribute vec3 aTint;
  varying float vA;
  varying float vMag;
  varying vec3 vTint;
  void main() {
    vec3 p = aPos;
    // the world streams past: wrap stars within the corridor depth
    p.z = mod(aPos.z + uTravel, ${CORRIDOR.depth.toFixed(1)}) - ${(CORRIDOR.depth - 8).toFixed(1)};
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = mix(1.4, 5.6, aMag) * uPx * (340.0 / max(1.0, -mv.z));
    float tw = 0.75 + 0.25 * sin(uTime * mix(0.2, 0.6, aMag) + aPhase * 50.0);
    // fade in at the far end so stars never pop into view
    float far = smoothstep(-${(CORRIDOR.depth - 12).toFixed(1)}, -${(CORRIDOR.depth - 42).toFixed(1)}, p.z);
    vA = mix(0.35, 1.0, aMag) * tw * far;
    vMag = aMag;
    vTint = aTint;
    gl_Position = projectionMatrix * mv;
  }
`;

const streamFragment = /* glsl */ `
  varying float vA;
  varying float vMag;
  varying vec3 vTint;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv) * 2.0;
    float ang = atan(uv.y, uv.x);
    float core = exp(-d * d * 6.0);
    // the brightest stars carry four-ray diffraction spikes
    float spike = pow(abs(cos(ang * 2.0)), 26.0) * exp(-d * 2.2)
                * smoothstep(0.72, 0.94, vMag) * 0.9;
    float a = (core + spike - 0.02) * vA;
    if (a <= 0.003) discard;
    gl_FragColor = vec4(vTint, a);
  }
`;

const dotFragment = /* glsl */ `
  uniform vec3 uColor;
  varying float vA;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv) * 2.0;
    float a = (exp(-d * d * 5.5) - 0.02) * vA;
    if (a <= 0.003) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

const starVertex = /* glsl */ `
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

const starFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uFlare;
  varying vec2 vUv;
  void main() {
    vec2 c = vUv - 0.5;
    float d = length(c) * 2.0;
    float ang = atan(c.y, c.x);
    float core = exp(-d * d * 24.0) * 1.25;
    float halo = exp(-d * d * 4.2) * 0.3;
    float spikes = pow(abs(cos(ang * 2.0)), 30.0) * exp(-d * 2.4) * (0.3 + uFlare * 0.9);
    float a = (core + halo + spikes) * uIntensity;
    if (a <= 0.004) discard;
    gl_FragColor = vec4(uColor * (1.0 + uFlare * 0.4), a);
  }
`;

const planetVertex = /* glsl */ `
  uniform vec3 uCenter;
  uniform float uOrbitTime;
  uniform float uPx;
  attribute float aR;
  attribute float aSpeed;
  attribute float aPhase;
  attribute float aIncl;
  attribute float aSize;
  varying float vA;
  void main() {
    float th = aPhase + uOrbitTime * aSpeed;
    vec3 p = uCenter + vec3(
      cos(th) * aR,
      sin(th) * aR * sin(aIncl),
      sin(th) * aR * cos(aIncl) * 0.6
    );
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aSize * uPx * (300.0 / max(1.0, -mv.z));
    vA = 0.9;
    gl_Position = projectionMatrix * mv;
  }
`;

const sparkVertex = /* glsl */ `
  uniform float uTime;
  uniform float uTravel;
  uniform float uPx;
  attribute vec3 aOrigin;
  attribute vec3 aVel;
  attribute float aBirth;
  attribute float aTravel0;  // travel distance at spawn
  attribute vec3 aColor;
  varying vec3 vColor;
  varying float vA;
  void main() {
    float age = uTime - aBirth;
    float t = clamp(age / ${SPARK_LIFE.toFixed(2)}, 0.0, 1.0);
    vec3 p = aOrigin + aVel * age;
    p.z += uTravel - aTravel0; // sparks are left behind in space
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = mix(3.0, 0.4, t) * uPx * (300.0 / max(1.0, -mv.z));
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

const headFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uFlare;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float core = exp(-d * d * 22.0) * 1.2;
    float halo = exp(-d * d * 4.5) * 0.3;
    float a = (core + halo) * uIntensity * (1.0 + uFlare * 0.8);
    if (a <= 0.004) discard;
    gl_FragColor = vec4(uColor * (1.0 + uFlare * 0.4), a);
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
  uniform float uWarm;
  varying vec3 vDir;
  void main() {
    float f = smoothstep(0.4, -0.9, vDir.z); // glow toward the direction of travel
    vec3 deep = vec3(0.006, 0.007, 0.018);
    vec3 ahead = mix(vec3(0.02, 0.025, 0.06), vec3(0.05, 0.035, 0.03), uWarm);
    vec3 c = mix(deep, ahead, f * (0.4 + uLift * 0.8));
    gl_FragColor = vec4(c, 1.0);
  }
`;

function additive(m: THREE.ShaderMaterial): THREE.ShaderMaterial {
  m.blending = THREE.AdditiveBlending;
  m.transparent = true;
  m.depthWrite = false;
  return m;
}

// ---------------------------------------------------------------------------

interface StarSystem {
  band: number;
  pos: THREE.Vector3;
  orbitTime: number;
  starMat: THREE.ShaderMaterial;
  planetMat: THREE.ShaderMaterial;
  starMesh: THREE.Mesh;
  planets: THREE.Points;
}

interface Ribbon {
  trail: TrailRibbon;
  head: THREE.Vector3;
  headMat: THREE.ShaderMaterial;
  headMesh: THREE.Mesh;
  x: number;
  y: number;
  salience: EnvelopeFollower;
  color: THREE.Color;
  phase: number;
}

export class Voyage implements Mode {
  private scene!: THREE.Scene;
  private renderer!: THREE.WebGLRenderer;
  private camera!: THREE.PerspectiveCamera;
  private group = new THREE.Group();
  private systems: StarSystem[] = [];
  private ribbons: Ribbon[] = [];

  private streamMat!: THREE.ShaderMaterial;
  private streamGeo!: THREE.BufferGeometry;
  private skyMat!: THREE.ShaderMaterial;
  private sparkMat!: THREE.ShaderMaterial;
  private sparkOrigin!: THREE.BufferAttribute;
  private sparkVel!: THREE.BufferAttribute;
  private sparkBirth!: THREE.BufferAttribute;
  private sparkTravel0!: THREE.BufferAttribute;
  private sparkColor!: THREE.BufferAttribute;
  private sparkCursor = 0;
  private disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  private time = 0;
  private travel = 0;
  private speed = 7;
  private warm = 0;
  private pointer = new THREE.Vector3(0, 0, -22);
  private pointerWeight = 0;
  private pointerSeen = -10;
  private novas: { pos: THREE.Vector3; age: number }[] = [];
  private novaFlash = 0;
  private yaw = 0;
  private pitch = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private lookTargetYaw = 0;
  private lookTargetPitch = 0;
  private aspect = 16 / 9;
  private savedFov = 55;
  private euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private rng = (() => {
    let s = 0x51ab3c;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
  })();

  init(scene: THREE.Scene, renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    this.savedFov = camera.fov;
    this.aspect = camera.aspect;
    camera.fov = this.aspect < 1 ? 88 : 66;
    camera.position.set(0, 0, 0);
    camera.updateProjectionMatrix();

    // deep space dome
    const skyGeo = new THREE.SphereGeometry(180, 24, 16);
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      uniforms: { uLift: { value: 0 }, uWarm: { value: 0 } },
      side: THREE.BackSide,
      depthWrite: false,
    });
    const sky = new THREE.Mesh(skyGeo, this.skyMat);
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    this.group.add(sky);

    // streaming starfield
    this.streamGeo = new THREE.BufferGeometry();
    const sp = new Float32Array(STREAM_STARS * 3);
    const sm = new Float32Array(STREAM_STARS);
    const sph = new Float32Array(STREAM_STARS);
    const stint = new Float32Array(STREAM_STARS * 3);
    const starTints = [
      { c: new THREE.Color('#ccd6ea'), w: 0.68 }, // cool white
      { c: new THREE.Color('#eacd9c'), w: 0.84 }, // gold
      { c: new THREE.Color('#9fb6ee'), w: 0.93 }, // blue giant
      { c: new THREE.Color('#dcaaa2'), w: 1.01 }, // rose
    ];
    for (let i = 0; i < STREAM_STARS; i++) {
      sp[i * 3] = (this.rng() - 0.5) * CORRIDOR.x * 2;
      sp[i * 3 + 1] = (this.rng() - 0.5) * CORRIDOR.y * 2;
      sp[i * 3 + 2] = -this.rng() * CORRIDOR.depth;
      sm[i] = Math.pow(this.rng(), 2.0);
      sph[i] = this.rng();
      const roll = this.rng();
      const tint = (starTints.find((t) => roll < t.w) ?? starTints[0]).c;
      stint[i * 3] = tint.r;
      stint[i * 3 + 1] = tint.g;
      stint[i * 3 + 2] = tint.b;
    }
    this.streamGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(STREAM_STARS * 3), 3));
    this.streamGeo.setAttribute('aPos', new THREE.BufferAttribute(sp, 3));
    this.streamGeo.setAttribute('aMag', new THREE.BufferAttribute(sm, 1));
    this.streamGeo.setAttribute('aPhase', new THREE.BufferAttribute(sph, 1));
    this.streamGeo.setAttribute('aTint', new THREE.BufferAttribute(stint, 3));
    this.streamGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.streamMat = additive(
      new THREE.ShaderMaterial({
        vertexShader: streamVertex,
        fragmentShader: streamFragment,
        uniforms: {
          uTravel: { value: 0 },
          uTime: { value: 0 },
          uPx: { value: 1 },
        },
      }),
    );
    const stream = new THREE.Points(this.streamGeo, this.streamMat);
    stream.frustumCulled = false;
    this.group.add(stream);

    // star systems
    const starGeo = new THREE.PlaneGeometry(1, 1);
    this.disposables.push(starGeo);
    for (let i = 0; i < SYSTEM_COUNT; i++) {
      const band = i % BAND_COUNT;
      const starMat = additive(
        new THREE.ShaderMaterial({
          vertexShader: starVertex,
          fragmentShader: starFragment,
          uniforms: {
            uCenter: { value: new THREE.Vector3() },
            uScale: { value: 2 },
            uColor: { value: new THREE.Color() },
            uIntensity: { value: 0.5 },
            uFlare: { value: 0 },
          },
        }),
      );
      const starMesh = new THREE.Mesh(starGeo, starMat);
      starMesh.frustumCulled = false;

      const pGeo = new THREE.BufferGeometry();
      const pR = new Float32Array(PLANETS_PER);
      const pS = new Float32Array(PLANETS_PER);
      const pPh = new Float32Array(PLANETS_PER);
      const pI = new Float32Array(PLANETS_PER);
      const pSz = new Float32Array(PLANETS_PER);
      for (let p = 0; p < PLANETS_PER; p++) {
        pR[p] = 1.6 + p * 1.1 + this.rng() * 0.5;
        pS[p] = (0.7 + this.rng() * 0.8) / Math.sqrt(1 + p); // outer slower
        pPh[p] = this.rng() * Math.PI * 2;
        pI[p] = 0.35 + this.rng() * 0.5;
        pSz[p] = 1.6 + this.rng() * 1.6;
      }
      pGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PLANETS_PER * 3), 3));
      pGeo.setAttribute('aR', new THREE.BufferAttribute(pR, 1));
      pGeo.setAttribute('aSpeed', new THREE.BufferAttribute(pS, 1));
      pGeo.setAttribute('aPhase', new THREE.BufferAttribute(pPh, 1));
      pGeo.setAttribute('aIncl', new THREE.BufferAttribute(pI, 1));
      pGeo.setAttribute('aSize', new THREE.BufferAttribute(pSz, 1));
      pGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
      const planetMat = additive(
        new THREE.ShaderMaterial({
          vertexShader: planetVertex,
          fragmentShader: dotFragment,
          uniforms: {
            uCenter: { value: new THREE.Vector3() },
            uOrbitTime: { value: this.rng() * 20 },
            uPx: { value: 1 },
            uColor: { value: new THREE.Color() },
          },
        }),
      );
      const planets = new THREE.Points(pGeo, planetMat);
      planets.frustumCulled = false;

      const sys: StarSystem = {
        band,
        pos: new THREE.Vector3(),
        orbitTime: this.rng() * 30,
        starMat,
        planetMat,
        starMesh,
        planets,
      };
      this.placeSystem(sys, -this.rng() * CORRIDOR.depth);
      this.group.add(starMesh, planets);
      this.systems.push(sys);
      this.disposables.push(pGeo, starMat, planetMat);
    }

    // sparks
    const sparkGeo = new THREE.BufferGeometry();
    this.sparkOrigin = new THREE.BufferAttribute(new Float32Array(SPARK_CAP * 3), 3);
    this.sparkVel = new THREE.BufferAttribute(new Float32Array(SPARK_CAP * 3), 3);
    this.sparkBirth = new THREE.BufferAttribute(new Float32Array(SPARK_CAP).fill(-100), 1);
    this.sparkTravel0 = new THREE.BufferAttribute(new Float32Array(SPARK_CAP), 1);
    this.sparkColor = new THREE.BufferAttribute(new Float32Array(SPARK_CAP * 3), 3);
    for (const a of [this.sparkOrigin, this.sparkVel, this.sparkBirth, this.sparkTravel0, this.sparkColor]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    sparkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARK_CAP * 3), 3));
    sparkGeo.setAttribute('aOrigin', this.sparkOrigin);
    sparkGeo.setAttribute('aVel', this.sparkVel);
    sparkGeo.setAttribute('aBirth', this.sparkBirth);
    sparkGeo.setAttribute('aTravel0', this.sparkTravel0);
    sparkGeo.setAttribute('aColor', this.sparkColor);
    sparkGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.sparkMat = additive(
      new THREE.ShaderMaterial({
        vertexShader: sparkVertex,
        fragmentShader: sparkFragment,
        uniforms: { uTime: { value: 0 }, uTravel: { value: 0 }, uPx: { value: 1 } },
      }),
    );
    const sparks = new THREE.Points(sparkGeo, this.sparkMat);
    sparks.frustumCulled = false;
    this.group.add(sparks);

    // voice ribbons
    const headGeo = new THREE.PlaneGeometry(1, 1);
    this.disposables.push(headGeo);
    for (let b = 0; b < BAND_COUNT; b++) {
      const headMat = additive(
        new THREE.ShaderMaterial({
          vertexShader: starVertex,
          fragmentShader: headFragment,
          uniforms: {
            uCenter: { value: new THREE.Vector3() },
            uScale: { value: 1 },
            uColor: { value: BAND_COLORS[b].clone() },
            uIntensity: { value: 0.2 },
            uFlare: { value: 0 },
          },
        }),
      );
      const headMesh = new THREE.Mesh(headGeo, headMat);
      headMesh.frustumCulled = false;
      // emit every frame: a discrete sampling interval reads as stepping
      const trail = new TrailRibbon(150, 0);
      const r: Ribbon = {
        trail,
        head: new THREE.Vector3(RIBBON_HOME_X[b], RIBBON_HOME_Y[b], -20),
        headMat,
        headMesh,
        x: RIBBON_HOME_X[b],
        y: RIBBON_HOME_Y[b],
        salience: new EnvelopeFollower(600, 1600),
        color: BAND_COLORS[b].clone(),
        phase: b * 2.4,
      };
      trail.reset(r.head, 0);
      this.group.add(headMesh, trail.mesh);
      this.ribbons.push(r);
      this.disposables.push(headMat);
    }

    this.disposables.push(skyGeo, this.streamGeo, sparkGeo, this.skyMat, this.streamMat, this.sparkMat);
    scene.add(this.group);
  }

  private placeSystem(sys: StarSystem, z: number): void {
    // keep a clear corridor in the middle for the ribbons to fly through
    const side = this.rng() > 0.5 ? 1 : -1;
    sys.pos.set(
      side * (9 + this.rng() * 26),
      (this.rng() - 0.5) * 26,
      z,
    );
  }

  private burst(origin: THREE.Vector3, color: THREE.Color, strength: number): void {
    const n = 4 + Math.floor(strength * 8);
    for (let i = 0; i < n; i++) {
      const k = this.sparkCursor;
      this.sparkCursor = (this.sparkCursor + 1) % SPARK_CAP;
      this.sparkOrigin.setXYZ(
        k,
        origin.x + (Math.random() - 0.5) * 0.5,
        origin.y + (Math.random() - 0.5) * 0.5,
        origin.z + (Math.random() - 0.5) * 0.5,
      );
      const sp = 1 + Math.random() * 2.5 * (0.5 + strength);
      const az = Math.random() * Math.PI * 2;
      const el = (Math.random() - 0.5) * Math.PI;
      this.sparkVel.setXYZ(
        k,
        Math.cos(el) * Math.cos(az) * sp,
        Math.sin(el) * sp,
        Math.cos(el) * Math.sin(az) * sp * 0.5,
      );
      this.sparkBirth.setX(k, this.time);
      this.sparkTravel0.setX(k, this.travel);
      this.sparkColor.setXYZ(k, color.r, color.g, color.b);
    }
    this.sparkOrigin.needsUpdate = true;
    this.sparkVel.needsUpdate = true;
    this.sparkBirth.needsUpdate = true;
    this.sparkTravel0.needsUpdate = true;
    this.sparkColor.needsUpdate = true;
  }

  update(frame: AnalysisFrame, dt: number): void {
    this.time += dt;
    const dtMs = dt * 1000;
    const px = this.renderer.getPixelRatio();

    // the voyage itself breathes with the piece: swells accelerate
    const speedTarget = 6 + frame.energySlow * 22 + frame.energyFast * 6;
    this.speed += (speedTarget - this.speed) * smoothK(1500, dtMs);
    this.travel += this.speed * dt;
    this.warm += (clamp01((frame.energySlow - 0.2) * 1.3) - this.warm) * smoothK(8000, dtMs);

    // pointer presence fades in while you move, lets go when you rest
    const pTarget = this.time - this.pointerSeen < 2.5 ? 1 : 0;
    this.pointerWeight += (pTarget - this.pointerWeight) * smoothK(500, dtMs);

    // supernovae: taps detonate, ribbons scatter, light washes the sky
    this.novaFlash = 0;
    for (const nv of this.novas) {
      nv.age += dt;
      this.novaFlash += Math.exp(-nv.age * 3);
    }
    this.novas = this.novas.filter((nv) => nv.age < 1.8);

    this.streamMat.uniforms.uTravel.value = this.travel;
    this.streamMat.uniforms.uTime.value = this.time;
    this.streamMat.uniforms.uPx.value = px;
    this.skyMat.uniforms.uLift.value = frame.energySlow + this.novaFlash * 0.7;
    this.skyMat.uniforms.uWarm.value = this.warm;
    this.sparkMat.uniforms.uTime.value = this.time;
    this.sparkMat.uniforms.uTravel.value = this.travel;
    this.sparkMat.uniforms.uPx.value = px;

    // ---- star systems stream past --------------------------------------
    for (const sys of this.systems) {
      sys.pos.z += this.speed * dt;
      if (sys.pos.z > 8) {
        this.placeSystem(sys, -CORRIDOR.depth + this.rng() * 14);
        sys.band = (sys.band + 1) % BAND_COUNT;
      }
      const band = frame.bands[sys.band];
      // each star is tuned to a voice: pulse, flare, and planet speed
      sys.orbitTime += dt * (0.25 + band.energy * 3.2);

      const su = sys.starMat.uniforms;
      (su.uCenter.value as THREE.Vector3).copy(sys.pos);
      su.uScale.value = 2.4 + band.energy * 3.4;
      (su.uColor.value as THREE.Color)
        .copy(BAND_COLORS[sys.band])
        .lerp(new THREE.Color('#f6efe2'), 0.35);
      su.uIntensity.value = 0.3 + band.energy * 0.75;
      su.uFlare.value = band.attackStrength;

      const pu = sys.planetMat.uniforms;
      (pu.uCenter.value as THREE.Vector3).copy(sys.pos);
      pu.uOrbitTime.value = sys.orbitTime;
      pu.uPx.value = px;
      (pu.uColor.value as THREE.Color).copy(BAND_COLORS[sys.band]).lerp(new THREE.Color('#9aa4b8'), 0.5);
    }

    // ---- ribbons ---------------------------------------------------------
    let leanX = 0;
    let leanY = 0;
    let leanWeight = 0;
    for (let b = 0; b < BAND_COUNT; b++) {
      const band = frame.bands[b];
      const r = this.ribbons[b];
      const salient = r.salience.process(frame.salientBand === b ? frame.salience : 0, dtMs);

      // lane from stereo (left voice flies on your left), register sets height
      const panTrust = clamp01(band.energy * 3) * 0.85;
      const xT = lerp(RIBBON_HOME_X[b], -band.pan * 13, panTrust);
      const yT = RIBBON_HOME_Y[b] + (band.pitch - 0.5) * 4;
      r.x += (xT - r.x) * smoothK(1300, dtMs);
      r.y += (yT - r.y) * smoothK(1300, dtMs);

      // undulating flight: loud voices surge ahead, quiet ones hang back
      const t = this.time;
      const hx = r.x + Math.sin(t * (0.5 + b * 0.07) + r.phase) * (1.6 + band.energy * 2.6);
      const hy = r.y + Math.sin(t * (0.4 + b * 0.05) + r.phase * 2.3) * (1.2 + band.energy * 2.0);
      let hz = -14 - band.energy * 13 + Math.sin(t * 0.3 + r.phase * 1.7) * 2.5;

      // slalom around the star systems we pass
      let ax = 0;
      let ay = 0;
      for (const sys of this.systems) {
        const dz = sys.pos.z - hz;
        const dx = hx - sys.pos.x;
        const dy = hy - sys.pos.y;
        const d2 = dx * dx + dy * dy;
        // smooth windows: the deflection eases in and out — a hard cutoff
        // would kick the ribbon as a star crosses the threshold
        const zw = clamp01((16 - Math.abs(dz)) / 9);
        const dw = clamp01((130 - d2) / 70);
        if (zw <= 0 || dw <= 0) continue;
        const f = (26 / (d2 + 6)) * zw * zw * dw;
        const inv = 1 / Math.sqrt(d2 + 1e-4);
        // push around, with a touch of swirl so it reads as an orbit-graze
        ax += (dx * inv) * f - (dy * inv) * f * 0.5;
        ay += (dy * inv) * f + (dx * inv) * f * 0.5;
      }

      // the ribbons are curious about you: they lean toward the pointer,
      // the high voices most eagerly, the bass with dignified reluctance
      const pw = this.pointerWeight * (0.45 + b * 0.14);
      ax += (this.pointer.x - hx) * 0.16 * pw;
      ay += (this.pointer.y - hy) * 0.16 * pw;

      // and they flee a supernova
      for (const nv of this.novas) {
        const dx = hx - nv.pos.x;
        const dy = hy - nv.pos.y;
        const d2 = dx * dx + dy * dy;
        const f = (60 / (d2 + 12)) * Math.exp(-nv.age * 2.4);
        const inv = 1 / Math.sqrt(d2 + 1e-4);
        ax += dx * inv * f;
        ay += dy * inv * f;
      }

      r.head.set(hx + ax, hy + ay, hz);

      r.color.copy(BAND_COLORS[b]).lerp(DIM_COLOR, (1 - salient) * frame.salience * 0.3);

      // the trail is left behind in space as we fly
      r.trail.drift(0, 0, this.speed * dt * 0.55);
      r.trail.update(
        this.time,
        r.head,
        r.color,
        (0.16 + band.energy * 0.7) * (0.55 + salient * 0.95),
        0.007 + band.energy * 0.012 + salient * 0.008,
        this.aspect,
      );

      const hu = r.headMat.uniforms;
      (hu.uCenter.value as THREE.Vector3).copy(r.head);
      hu.uScale.value = (0.7 + band.energy * 1.5) * (1 + salient * 0.4);
      (hu.uColor.value as THREE.Color).copy(r.color);
      hu.uIntensity.value = Math.min(1, 0.1 + Math.pow(band.energy, 1.15) * 0.8 * (1 + salient * 0.6));
      hu.uFlare.value = band.attackStrength;

      if (band.attack && band.attackStrength > 0.15) {
        this.burst(r.head, r.color, band.attackStrength);
      }

      if (salient > leanWeight) {
        leanWeight = salient;
        leanX = r.head.x;
        leanY = r.head.y;
      }
    }

    // ---- camera: gaze drifts after the melody's ribbon -------------------
    const yawT = clamp(-Math.atan2(leanX, 20) * 0.45, -0.18, 0.18) * leanWeight;
    const pitchT = clamp(Math.atan2(leanY, 20) * 0.4, -0.12, 0.12) * leanWeight;
    this.yaw += (yawT - this.yaw) * smoothK(2800, dtMs);
    this.pitch += (pitchT - this.pitch) * smoothK(2800, dtMs);
    const kLook = smoothK(400, dtMs);
    this.lookYaw += (this.lookTargetYaw - this.lookYaw) * kLook;
    this.lookPitch += (this.lookTargetPitch - this.lookPitch) * kLook;

    this.camera.position.set(
      Math.sin(this.time * (Math.PI * 2 / 29)) * 0.4,
      Math.sin(this.time * (Math.PI * 2 / 21)) * 0.3,
      0,
    );
    this.euler.set(
      this.pitch + this.lookPitch + Math.sin(this.time * (Math.PI * 2 / 17)) * 0.006,
      this.yaw + this.lookYaw + Math.sin(this.time * (Math.PI * 2 / 23)) * 0.006,
      Math.sin(this.time * (Math.PI * 2 / 37)) * 0.005,
    );
    this.camera.quaternion.setFromEuler(this.euler);
  }

  resize(w: number, h: number): void {
    this.aspect = w / h;
    this.camera.fov = this.aspect < 1 ? 88 : 66;
    this.camera.updateProjectionMatrix();
  }

  setQuality(level: number): void {
    const stars = level >= 2 ? STREAM_STARS : level === 1 ? 1600 : 900;
    this.streamGeo.setDrawRange(0, stars);
  }

  setLook(x: number, y: number): void {
    this.lookTargetYaw = clamp(x, -1, 1) * THREE.MathUtils.degToRad(40);
    this.lookTargetPitch = clamp(y, -1, 1) * THREE.MathUtils.degToRad(22);
  }

  /** Project an NDC point onto the ribbon plane ~22 units ahead. */
  private project(nx: number, ny: number, out: THREE.Vector3): THREE.Vector3 {
    const halfH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * 22;
    return out.set(nx * halfH * this.aspect, ny * halfH, -22);
  }

  setPointer(x: number, y: number): void {
    this.project(x, y, this.pointer);
    this.pointerSeen = this.time;
  }

  tap(x: number, y: number): void {
    const pos = this.project(x, y, new THREE.Vector3());
    this.novas.push({ pos, age: 0 });
    if (this.novas.length > 4) this.novas.shift();
    const flash = new THREE.Color('#f6ecd0');
    this.burst(pos, flash, 1);
    this.burst(pos, new THREE.Color('#e8c98a'), 0.9);
    this.burst(pos, new THREE.Color('#aebfe8'), 0.8);
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const d of this.disposables) d.dispose();
    for (const r of this.ribbons) r.trail.dispose();
    this.ribbons = [];
    this.systems = [];
    this.camera.fov = this.savedFov;
    this.camera.position.set(0, 2.5, 9.5);
    this.camera.rotation.set(0, 0, 0);
    this.camera.updateProjectionMatrix();
  }
}
