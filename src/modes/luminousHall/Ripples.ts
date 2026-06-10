import * as THREE from 'three';

/**
 * Onset ripples: a pooled set of camera-facing quads, each drawing an
 * expanding annulus of light that fades as it grows. A pulse, not a strobe.
 */

const POOL_SIZE = 14;
const LIFETIME = 1.4; // seconds

const rippleVertex = /* glsl */ `
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

const rippleFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uProgress; // 0..1 over the ripple's life
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float ringR = uProgress * 0.92;
    float band = exp(-pow((r - ringR) * 9.0, 2.0));
    float a = band * (1.0 - uProgress) * (1.0 - uProgress) * uStrength * 0.55;
    if (a <= 0.003) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

interface Ripple {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  age: number;
  active: boolean;
}

export class Ripples {
  readonly group = new THREE.Group();
  private pool: Ripple[] = [];
  private geo: THREE.PlaneGeometry;

  constructor() {
    this.geo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < POOL_SIZE; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: rippleVertex,
        fragmentShader: rippleFragment,
        uniforms: {
          uCenter: { value: new THREE.Vector3() },
          uScale: { value: 4 },
          uColor: { value: new THREE.Color() },
          uProgress: { value: 0 },
          uStrength: { value: 0 },
        },
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.pool.push({ mesh, mat, age: 0, active: false });
    }
  }

  spawn(center: THREE.Vector3, color: THREE.Color, strength: number): void {
    const r = this.pool.find((p) => !p.active);
    if (!r) return; // pool exhausted: drop quietly rather than strobe
    r.active = true;
    r.age = 0;
    r.mesh.visible = true;
    (r.mat.uniforms.uCenter.value as THREE.Vector3).copy(center);
    (r.mat.uniforms.uColor.value as THREE.Color).copy(color);
    r.mat.uniforms.uStrength.value = 0.25 + strength * 0.75;
    r.mat.uniforms.uScale.value = 3.5 + strength * 5.5;
  }

  update(dt: number): void {
    for (const r of this.pool) {
      if (!r.active) continue;
      r.age += dt;
      const t = r.age / LIFETIME;
      if (t >= 1) {
        r.active = false;
        r.mesh.visible = false;
        continue;
      }
      // ease-out expansion
      r.mat.uniforms.uProgress.value = 1 - (1 - t) * (1 - t);
    }
  }

  dispose(): void {
    this.geo.dispose();
    for (const r of this.pool) r.mat.dispose();
  }
}
