import * as THREE from 'three';
import type { Mode } from '../Mode';
import type { AnalysisFrame } from '../../audio/analysis';
import { BAND_COUNT } from '../../audio/analysis';
import { EnvelopeFollower, clamp, clamp01, lerp, smoothK } from '../../audio/smoothing';
import { TrailRibbon } from '../shared/TrailRibbon';
import { BAND_COLORS, DIM_COLOR } from '../luminousHall/palette';

/**
 * Mode 4 — Celestial Mechanics.
 * The five voices are luminous bodies orbiting the viewer under a night sky,
 * leaving trails of light. Pitch is altitude, stereo is direction, loudness
 * draws a body nearer. Consonant, settled passages pull the orbits into a
 * shared inclined plane; busy, dissonant ones scatter them into wobble.
 * Call-and-response reads as bodies answering each other across the sky.
 */

const STAR_COUNT = 1100;
const ELEV_BASE = [0.16, 0.34, 0.52, 0.70, 0.88]; // radians above horizon
const ORBIT_SPEED = [0.045, 0.06, 0.075, 0.09, 0.11]; // bass slow, brilliance quick

const starVertex = /* glsl */ `
  uniform float uTime;
  uniform float uPx;
  attribute float aMag;
  attribute float aPhase;
  varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = mix(0.8, 2.2, aMag) * uPx * (300.0 / max(1.0, -mv.z));
    vA = mix(0.2, 0.85, aMag) * (0.7 + 0.3 * sin(uTime * mix(0.1, 0.4, aMag) + aPhase * 40.0));
    gl_Position = projectionMatrix * mv;
  }
`;

const starFragment = /* glsl */ `
  uniform vec3 uColor;
  varying float vA;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv) * 2.0;
    float a = (exp(-d * d * 5.0) - 0.02) * vA;
    if (a <= 0.003) discard;
    gl_FragColor = vec4(uColor, a);
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
    float d = length(vUv - 0.5) * 2.0;
    float core = exp(-d * d * 30.0) * 1.2;
    float halo = exp(-d * d * 4.0) * 0.35;
    float rays = exp(-d * d * 9.0) * uFlare * 0.6
               * (0.5 + 0.5 * cos(atan(vUv.y - 0.5, vUv.x - 0.5) * 6.0));
    float a = (core + halo + rays) * uIntensity;
    if (a <= 0.004) discard;
    gl_FragColor = vec4(uColor * (1.0 + uFlare * 0.4), a);
  }
`;

const horizonVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const horizonFragment = /* glsl */ `
  uniform vec3 uColorLow;
  uniform vec3 uColorHigh;
  uniform float uLift;
  varying vec3 vDir;
  void main() {
    float h = clamp(vDir.y, -1.0, 1.0);
    vec3 c = mix(uColorLow, uColorHigh, smoothstep(-0.1, 0.7, h));
    c *= 1.0 + uLift * 0.5 * exp(-h * h * 8.0); // music brightens the horizon
    gl_FragColor = vec4(c, 1.0);
  }
`;

interface OrbitBody {
  azimuth: number;
  elevation: number;
  radius: number;
  mesh: THREE.Mesh;
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
  private group = new THREE.Group();
  private bodies: OrbitBody[] = [];
  private starMat!: THREE.ShaderMaterial;
  private horizonMat!: THREE.ShaderMaterial;
  private disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  private time = 0;
  private yaw = 0;
  private yawTarget = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private lookTargetYaw = 0;
  private lookTargetPitch = 0;
  private aspect = 16 / 9;
  private savedFov = 55;
  private euler = new THREE.Euler(0, 0, 0, 'YXZ');

  init(scene: THREE.Scene, renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    this.savedFov = camera.fov;
    camera.fov = 68;
    camera.position.set(0, 1.6, 0);
    camera.updateProjectionMatrix();
    this.aspect = camera.aspect;

    // night dome
    const domeGeo = new THREE.SphereGeometry(160, 24, 16);
    this.horizonMat = new THREE.ShaderMaterial({
      vertexShader: horizonVertex,
      fragmentShader: horizonFragment,
      uniforms: {
        uColorLow: { value: new THREE.Color('#0d1020') },
        uColorHigh: { value: new THREE.Color('#020208') },
        uLift: { value: 0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
    });
    const dome = new THREE.Mesh(domeGeo, this.horizonMat);
    dome.renderOrder = -10;
    dome.frustumCulled = false;

    // stars
    const starGeo = new THREE.BufferGeometry();
    const sp = new Float32Array(STAR_COUNT * 3);
    const mag = new Float32Array(STAR_COUNT);
    const ph = new Float32Array(STAR_COUNT);
    let s = 1234567;
    const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
    for (let i = 0; i < STAR_COUNT; i++) {
      // uniform on upper hemisphere-ish shell
      const az = rng() * Math.PI * 2;
      const el = Math.asin(rng() * 0.98 + 0.02);
      const r = 130;
      sp[i * 3] = Math.cos(el) * Math.sin(az) * r;
      sp[i * 3 + 1] = Math.sin(el) * r;
      sp[i * 3 + 2] = Math.cos(el) * Math.cos(az) * r;
      mag[i] = Math.pow(rng(), 2.2);
      ph[i] = rng();
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    starGeo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    starGeo.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: starVertex,
      fragmentShader: starFragment,
      uniforms: {
        uTime: { value: 0 },
        uPx: { value: 1 },
        uColor: { value: new THREE.Color('#cfd6e4') },
      },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const stars = new THREE.Points(starGeo, this.starMat);
    stars.frustumCulled = false;

    this.group.add(dome, stars);
    this.disposables.push(domeGeo, starGeo, this.horizonMat, this.starMat);

    // bodies
    const bodyGeo = new THREE.PlaneGeometry(1, 1);
    this.disposables.push(bodyGeo);
    for (let b = 0; b < BAND_COUNT; b++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: bodyVertex,
        fragmentShader: bodyFragment,
        uniforms: {
          uCenter: { value: new THREE.Vector3() },
          uScale: { value: 1.2 },
          uColor: { value: BAND_COLORS[b].clone() },
          uIntensity: { value: 0.1 },
          uFlare: { value: 0 },
        },
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(bodyGeo, mat);
      mesh.frustumCulled = false;
      const trail = new TrailRibbon(80, 0.045);
      const azimuth = (b / BAND_COUNT) * Math.PI * 0.8 - Math.PI * 0.4;
      const body: OrbitBody = {
        azimuth,
        elevation: ELEV_BASE[b],
        radius: 22,
        mesh,
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

    scene.add(this.group);
  }

  private orbitToPosition(b: OrbitBody): void {
    const ce = Math.cos(b.elevation);
    b.position.set(
      Math.sin(b.azimuth) * ce * b.radius,
      1.6 + Math.sin(b.elevation) * b.radius,
      -Math.cos(b.azimuth) * ce * b.radius,
    );
  }

  update(frame: AnalysisFrame, dt: number): void {
    this.time += dt;
    const dtMs = dt * 1000;
    const px = this.renderer.getPixelRatio();

    this.starMat.uniforms.uTime.value = this.time;
    this.starMat.uniforms.uPx.value = px;
    this.horizonMat.uniforms.uLift.value = frame.energySlow;

    // settled music aligns the orbits into one inclined plane;
    // busy or rough music scatters them
    const calm = clamp01(1 - frame.flux * 1.3);

    let salientAz = 0;
    let salientWeight = 0;

    for (let b = 0; b < BAND_COUNT; b++) {
      const band = frame.bands[b];
      const body = this.bodies[b];
      const salient = body.salience.process(
        frame.salientBand === b ? frame.salience : 0,
        dtMs,
      );

      // orbital drift plus a pull toward the band's stereo direction
      body.azimuth += dt * ORBIT_SPEED[b] * (0.4 + band.energy * 1.6);
      const azTarget = band.pan * 1.15; // radians: ±66° across the front sky
      const panTrust = clamp01(band.energy * 3) * 0.85;
      // wrap-free ease toward the stereo direction
      let azErr = azTarget - body.azimuth;
      azErr = Math.atan2(Math.sin(azErr), Math.cos(azErr));
      body.azimuth += azErr * smoothK(2600, dtMs) * panTrust;

      // altitude: register base + in-band pitch, drawn toward the shared
      // plane when the music is consonant and settled
      const elevOwn = ELEV_BASE[b] + (band.pitch - 0.5) * 0.22;
      const plane = 0.5 + Math.sin(body.azimuth + this.time * 0.05) * 0.18;
      const elevTarget = lerp(elevOwn, plane, calm * 0.55);
      // dissonance shakes the orbit
      const wobble = frame.flux * 0.05 * Math.sin(this.time * 3.1 + b * 2.4);
      body.elevation += (elevTarget + wobble - body.elevation) * smoothK(1500, dtMs);
      body.elevation = clamp(body.elevation, 0.06, 1.25);

      // loudness approaches
      const radTarget = lerp(24, 12, clamp01(band.energy * 1.1));
      body.radius += (radTarget - body.radius) * smoothK(1100, dtMs);

      this.orbitToPosition(body);

      body.color.copy(BAND_COLORS[b]).lerp(DIM_COLOR, (1 - salient) * frame.salience * 0.35);

      const intensity = Math.min(
        1.0,
        0.07 + Math.pow(band.energy, 1.2) * 0.7 * (1 + salient * 0.7),
      );
      const u = body.mat.uniforms;
      (u.uCenter.value as THREE.Vector3).copy(body.position);
      u.uScale.value = (0.7 + band.energy * 1.6) * (1 + salient * 0.4);
      (u.uColor.value as THREE.Color).copy(body.color);
      u.uIntensity.value = intensity;
      u.uFlare.value = band.attackStrength;

      body.trail.update(
        this.time,
        body.position,
        body.color,
        (0.1 + band.energy * 0.5) * (0.5 + salient * 0.9),
        0.006 + band.energy * 0.008 + salient * 0.006,
        this.aspect,
      );

      if (salient > salientWeight) {
        salientWeight = salient;
        salientAz = body.azimuth;
      }
    }

    // camera: slow gaze that follows the melody across the sky
    this.yawTarget = clamp(salientAz, -1.1, 1.1) * salientWeight;
    this.yaw += (this.yawTarget - this.yaw) * smoothK(3000, dtMs);
    const kLook = smoothK(400, dtMs);
    this.lookYaw += (this.lookTargetYaw - this.lookYaw) * kLook;
    this.lookPitch += (this.lookTargetPitch - this.lookPitch) * kLook;

    const breathe = Math.sin(this.time * (Math.PI * 2 / 19)) * 0.012;
    this.euler.set(
      0.32 + this.lookPitch + Math.sin(this.time * (Math.PI * 2 / 13)) * 0.01,
      -this.yaw + this.lookYaw + breathe,
      Math.sin(this.time * (Math.PI * 2 / 29)) * 0.004,
    );
    this.camera.quaternion.setFromEuler(this.euler);
  }

  resize(w: number, h: number): void {
    this.aspect = w / h;
  }

  setQuality(level: number): void {
    const stars = level >= 2 ? STAR_COUNT : level === 1 ? STAR_COUNT / 2 : STAR_COUNT / 4;
    for (const obj of this.group.children) {
      if (obj instanceof THREE.Points) obj.geometry.setDrawRange(0, stars);
    }
  }

  setLook(x: number, y: number): void {
    this.lookTargetYaw = clamp(x, -1, 1) * THREE.MathUtils.degToRad(40);
    this.lookTargetPitch = clamp(y, -1, 1) * THREE.MathUtils.degToRad(22);
  }

  dispose(): void {
    this.scene.remove(this.group);
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
