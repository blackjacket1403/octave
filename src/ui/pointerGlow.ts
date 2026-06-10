import * as THREE from 'three';

/**
 * A light that follows the pointer — a soft candle-gold glow with a short
 * comet tail of fading echoes. Screen-space, mode-independent: it lives in
 * the main scene above every visualization. It trails the cursor with a
 * little lag, breathes with the music, and fades away when the hand rests.
 */

const ECHOES = 12; // head + trailing echoes

const vertexShader = /* glsl */ `
  uniform float uPx;
  attribute float aIdx; // 0 = head … 1 = oldest echo
  varying float vIdx;
  void main() {
    vIdx = aIdx;
    gl_PointSize = mix(110.0, 26.0, aIdx) * uPx;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  uniform float uIntensity;
  varying float vIdx;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv) * 2.0;
    float halo = exp(-d * d * 4.0) * 0.16;
    float core = exp(-d * d * 22.0) * 0.5 * (1.0 - vIdx);
    float fade = (1.0 - vIdx) * (1.0 - vIdx);
    float a = (halo + core) * uIntensity * mix(1.0, 0.25, vIdx) * (0.35 + 0.65 * fade);
    if (a <= 0.004) discard;
    vec3 c = mix(uColor, uCore, exp(-d * d * 14.0));
    gl_FragColor = vec4(c, a);
  }
`;

export class PointerGlow {
  readonly points: THREE.Points;
  private mat: THREE.ShaderMaterial;
  private geo: THREE.BufferGeometry;
  private pos: THREE.BufferAttribute;
  private trail: { x: number; y: number }[] = [];
  private target = { x: 0, y: 0 };
  private head = { x: 0, y: 0 };
  private intensity = 0;
  private lastMove = -10;
  private time = 0;
  private emitAcc = 0;
  private seen = false;

  constructor() {
    this.geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(ECHOES * 3), 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    const idx = new Float32Array(ECHOES);
    for (let i = 0; i < ECHOES; i++) {
      idx[i] = i / (ECHOES - 1);
      this.trail.push({ x: 0, y: 0 });
    }
    this.geo.setAttribute('position', this.pos);
    this.geo.setAttribute('aIdx', new THREE.BufferAttribute(idx, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.mat = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uPx: { value: 1 },
        uColor: { value: new THREE.Color('#d8b46a') },
        uCore: { value: new THREE.Color('#f6eedb') },
        uIntensity: { value: 0 },
      },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 200; // above every mode, including screen quads
    this.points.visible = false;
  }

  /** Pointer position in NDC. */
  onMove(x: number, y: number): void {
    this.target.x = x;
    this.target.y = y;
    if (!this.seen) {
      // first sighting: snap, don't streak in from the origin
      this.seen = true;
      this.head.x = x;
      this.head.y = y;
      for (const t of this.trail) {
        t.x = x;
        t.y = y;
      }
    }
    this.lastMove = this.time;
  }

  update(dt: number, px: number, energy: number): void {
    this.time += dt;

    // the light eases after the cursor, and rests ~1.6s after the hand does
    const want = this.time - this.lastMove < 1.6 ? 1 : 0;
    this.intensity += (want - this.intensity) * Math.min(1, dt * (want ? 6 : 2));
    this.points.visible = this.intensity > 0.01;
    if (!this.points.visible) return;

    const k = Math.min(1, dt * 9);
    this.head.x += (this.target.x - this.head.x) * k;
    this.head.y += (this.target.y - this.head.y) * k;

    // echoes are sampled snapshots of where the light has been
    this.emitAcc += dt;
    if (this.emitAcc >= 0.028) {
      this.emitAcc = 0;
      for (let i = ECHOES - 1; i > 0; i--) {
        this.trail[i].x = this.trail[i - 1].x;
        this.trail[i].y = this.trail[i - 1].y;
      }
    }
    this.trail[0].x = this.head.x;
    this.trail[0].y = this.head.y;

    for (let i = 0; i < ECHOES; i++) {
      this.pos.setXYZ(i, this.trail[i].x, this.trail[i].y, 0);
    }
    this.pos.needsUpdate = true;

    this.mat.uniforms.uPx.value = px;
    // the light breathes faintly with the music
    this.mat.uniforms.uIntensity.value =
      this.intensity * (0.8 + energy * 0.45 + 0.07 * Math.sin(this.time * 2.1));
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
