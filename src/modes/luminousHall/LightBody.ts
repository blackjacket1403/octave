import * as THREE from 'three';

/**
 * One register's voice: a breathing swarm of instanced glow sprites, a soft
 * halo, an optional motion trail, and a dimmed mirror image for the floor
 * reflection. All particle motion lives in the vertex shader — per frame the
 * CPU only writes a handful of uniforms.
 */

const SWARM_COUNT = 240;
const TRAIL_COUNT = 56;

const swarmVertex = /* glsl */ `
  uniform float uTime;
  uniform vec3 uCenter;
  uniform float uSpread;
  uniform float uSize;
  uniform float uEnergy;
  uniform float uMirror;
  uniform float uPx;
  attribute vec3 aSeed;
  attribute float aPhase;
  varying float vFade;
  void main() {
    float r = mix(0.2, 1.0, aSeed.x);
    float s1 = mix(0.06, 0.3, aSeed.y);
    float s2 = mix(0.05, 0.24, aSeed.z);
    float a1 = aPhase * 6.28318 + uTime * s1;
    float a2 = aPhase * 12.9 + uTime * s2;
    vec3 off = vec3(cos(a1) * sin(a2 + aSeed.x * 3.0), sin(a1) * 0.75, cos(a2)) * (r * uSpread);
    off *= 1.0 + 0.1 * sin(uTime * 0.5 + aPhase * 6.28318);
    vec3 p = uCenter + off;
    if (uMirror > 0.5) p.y = -p.y;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float size = uSize * mix(0.35, 1.4, aSeed.y) * (0.55 + 0.6 * uEnergy);
    gl_PointSize = size * uPx * (300.0 / max(1.0, -mv.z));
    vFade = mix(0.45, 1.0, aSeed.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const swarmFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  varying float vFade;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv) * 2.0;
    float a = exp(-d * d * 5.0) - 0.015;
    if (a <= 0.0) discard;
    gl_FragColor = vec4(uColor, a * uIntensity * vFade * 0.38);
  }
`;

const haloVertex = /* glsl */ `
  uniform vec3 uCenter;
  uniform float uScale;
  uniform float uMirror;
  varying vec2 vUv;
  void main() {
    vec3 c = uCenter;
    if (uMirror > 0.5) c.y = -c.y;
    vec4 mv = modelViewMatrix * vec4(c, 1.0);
    mv.xy += position.xy * uScale;
    vUv = uv;
    gl_Position = projectionMatrix * mv;
  }
`;

const haloFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float a = exp(-d * d * 3.4) * 0.2 + exp(-d * d * 16.0) * 0.3;
    gl_FragColor = vec4(uColor, a * uIntensity);
  }
`;

const trailVertex = /* glsl */ `
  uniform float uTime;
  uniform float uPx;
  attribute float aBirth;
  attribute float aSize;
  varying float vAlpha;
  void main() {
    float age = uTime - aBirth;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float fade = exp(-age * 1.4);
    vAlpha = age > 8.0 ? 0.0 : fade;
    gl_PointSize = aSize * uPx * (0.4 + 0.6 * fade) * (300.0 / max(1.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const trailFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  varying float vAlpha;
  void main() {
    float a = vAlpha * uIntensity;
    if (a <= 0.004) discard;
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv) * 2.0;
    gl_FragColor = vec4(uColor, exp(-d * d * 5.0) * a);
  }
`;

function additive(material: THREE.ShaderMaterial): THREE.ShaderMaterial {
  material.blending = THREE.AdditiveBlending;
  material.transparent = true;
  material.depthWrite = false;
  return material;
}

export class LightBody {
  readonly group = new THREE.Group();
  readonly position = new THREE.Vector3();
  readonly color = new THREE.Color();

  private swarmMat: THREE.ShaderMaterial;
  private swarmMirrorMat: THREE.ShaderMaterial;
  private haloMat: THREE.ShaderMaterial;
  private haloMirrorMat: THREE.ShaderMaterial;
  private trailMat: THREE.ShaderMaterial;
  private trailGeo: THREE.BufferGeometry;
  private trailPos: THREE.BufferAttribute;
  private trailBirth: THREE.BufferAttribute;
  private trailHead = 0;
  private lastTrailEmit = -1;
  private mirrorObjects: THREE.Object3D[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.ShaderMaterial[] = [];

  constructor(rng: () => number) {
    // ---- swarm ----
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(SWARM_COUNT * 3); // unused, shader-driven
    const seeds = new Float32Array(SWARM_COUNT * 3);
    const phases = new Float32Array(SWARM_COUNT);
    for (let i = 0; i < SWARM_COUNT; i++) {
      seeds[i * 3] = rng();
      seeds[i * 3 + 1] = rng();
      seeds[i * 3 + 2] = rng();
      phases[i] = rng();
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    // shader positions points anywhere near the center; avoid culling
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    const makeSwarmMat = (mirror: number) =>
      additive(
        new THREE.ShaderMaterial({
          vertexShader: swarmVertex,
          fragmentShader: swarmFragment,
          uniforms: {
            uTime: { value: 0 },
            uCenter: { value: new THREE.Vector3() },
            uSpread: { value: 1.6 },
            uSize: { value: 3.4 },
            uEnergy: { value: 0 },
            uPx: { value: 1 },
            uMirror: { value: mirror },
            uColor: { value: new THREE.Color() },
            uIntensity: { value: 0.08 },
          },
        }),
      );

    this.swarmMat = makeSwarmMat(0);
    this.swarmMirrorMat = makeSwarmMat(1);
    const swarm = new THREE.Points(geo, this.swarmMat);
    const swarmMirror = new THREE.Points(geo, this.swarmMirrorMat);
    swarm.frustumCulled = false;
    swarmMirror.frustumCulled = false;

    // ---- halo ----
    const haloGeo = new THREE.PlaneGeometry(1, 1);
    const makeHaloMat = (mirror: number) =>
      additive(
        new THREE.ShaderMaterial({
          vertexShader: haloVertex,
          fragmentShader: haloFragment,
          uniforms: {
            uCenter: { value: new THREE.Vector3() },
            uScale: { value: 2 },
            uMirror: { value: mirror },
            uColor: { value: new THREE.Color() },
            uIntensity: { value: 0.06 },
          },
        }),
      );
    this.haloMat = makeHaloMat(0);
    this.haloMirrorMat = makeHaloMat(1);
    const halo = new THREE.Mesh(haloGeo, this.haloMat);
    const haloMirror = new THREE.Mesh(haloGeo, this.haloMirrorMat);
    halo.frustumCulled = false;
    haloMirror.frustumCulled = false;

    // ---- trail ----
    this.trailGeo = new THREE.BufferGeometry();
    const tp = new Float32Array(TRAIL_COUNT * 3);
    const tb = new Float32Array(TRAIL_COUNT).fill(-100);
    const ts = new Float32Array(TRAIL_COUNT);
    for (let i = 0; i < TRAIL_COUNT; i++) ts[i] = 2.6 + rng() * 3.2;
    this.trailPos = new THREE.BufferAttribute(tp, 3);
    this.trailBirth = new THREE.BufferAttribute(tb, 1);
    this.trailPos.setUsage(THREE.DynamicDrawUsage);
    this.trailBirth.setUsage(THREE.DynamicDrawUsage);
    this.trailGeo.setAttribute('position', this.trailPos);
    this.trailGeo.setAttribute('aBirth', this.trailBirth);
    this.trailGeo.setAttribute('aSize', new THREE.BufferAttribute(ts, 1));
    this.trailGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.trailMat = additive(
      new THREE.ShaderMaterial({
        vertexShader: trailVertex,
        fragmentShader: trailFragment,
        uniforms: {
          uTime: { value: 0 },
          uColor: { value: new THREE.Color() },
          uIntensity: { value: 0 },
          uPx: { value: 1 },
        },
      }),
    );
    const trail = new THREE.Points(this.trailGeo, this.trailMat);
    trail.frustumCulled = false;

    this.group.add(swarm, swarmMirror, halo, haloMirror, trail);
    this.mirrorObjects.push(swarmMirror, haloMirror);
    this.geometries.push(geo, haloGeo, this.trailGeo);
    this.materials.push(
      this.swarmMat,
      this.swarmMirrorMat,
      this.haloMat,
      this.haloMirrorMat,
      this.trailMat,
    );
  }

  /**
   * @param energy      smoothed band loudness 0..1
   * @param intensity   final glow brightness (energy + salience boosts)
   * @param spread      swarm cluster radius (salient bodies tighten)
   * @param trailLevel  0..1, > 0 only for the salient body
   */
  update(
    time: number,
    center: THREE.Vector3,
    color: THREE.Color,
    energy: number,
    intensity: number,
    spread: number,
    trailLevel: number,
    px = 1,
  ): void {
    this.position.copy(center);
    this.color.copy(color);

    for (const m of [this.swarmMat, this.swarmMirrorMat]) {
      m.uniforms.uTime.value = time;
      (m.uniforms.uCenter.value as THREE.Vector3).copy(center);
      m.uniforms.uSpread.value = spread;
      m.uniforms.uEnergy.value = energy;
      m.uniforms.uPx.value = px;
      (m.uniforms.uColor.value as THREE.Color).copy(color);
    }
    this.swarmMat.uniforms.uIntensity.value = intensity;
    this.swarmMirrorMat.uniforms.uIntensity.value = intensity * 0.22;
    this.swarmMirrorMat.uniforms.uSize.value = 4.4; // larger = pseudo-blurred
    this.trailMat.uniforms.uPx.value = px;

    for (const m of [this.haloMat, this.haloMirrorMat]) {
      (m.uniforms.uCenter.value as THREE.Vector3).copy(center);
      (m.uniforms.uColor.value as THREE.Color).copy(color);
      m.uniforms.uScale.value = 1.9 + energy * 3.4;
    }
    this.haloMat.uniforms.uIntensity.value = 0.08 + intensity * 0.5;
    this.haloMirrorMat.uniforms.uIntensity.value = (0.08 + intensity * 0.5) * 0.3;

    // trail: drop a breadcrumb of light behind the body's motion
    this.trailMat.uniforms.uTime.value = time;
    (this.trailMat.uniforms.uColor.value as THREE.Color).copy(color);
    this.trailMat.uniforms.uIntensity.value = trailLevel * 0.5;
    if (trailLevel > 0.05 && time - this.lastTrailEmit > 0.05) {
      this.lastTrailEmit = time;
      const i = this.trailHead;
      this.trailHead = (this.trailHead + 1) % TRAIL_COUNT;
      const jitter = 0.35;
      this.trailPos.setXYZ(
        i,
        center.x + (Math.random() - 0.5) * jitter,
        center.y + (Math.random() - 0.5) * jitter,
        center.z + (Math.random() - 0.5) * jitter,
      );
      this.trailBirth.setX(i, time);
      this.trailPos.needsUpdate = true;
      this.trailBirth.needsUpdate = true;
    }
  }

  setMirrorVisible(visible: boolean): void {
    for (const o of this.mirrorObjects) o.visible = visible;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
