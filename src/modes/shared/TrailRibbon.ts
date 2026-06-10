import * as THREE from 'three';

/**
 * A fading ribbon of light tracing a moving point's recent path.
 * Vertices expand perpendicular to the projected polyline in screen space,
 * so the ribbon always faces the camera and tapers toward its tail.
 */

const ribbonVertex = /* glsl */ `
  uniform float uAspect;
  uniform float uWidth;
  attribute vec3 aPrev;
  attribute float aT;    // 0 = tail … 1 = head
  attribute float aSide; // -1 / +1
  varying float vT;
  varying float vSide;
  void main() {
    vec4 cur = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vec4 prv = projectionMatrix * modelViewMatrix * vec4(aPrev, 1.0);
    vec2 nCur = cur.xy / max(cur.w, 1e-4);
    vec2 nPrv = prv.xy / max(prv.w, 1e-4);
    vec2 dir = nCur - nPrv;
    dir.x *= uAspect;
    float len = length(dir);
    dir = len > 1e-5 ? dir / len : vec2(0.0, 1.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    nrm.x /= uAspect;
    float w = uWidth * (0.15 + 0.85 * aT);
    cur.xy += nrm * aSide * w * cur.w;
    vT = aT;
    vSide = aSide;
    gl_Position = cur;
  }
`;

const ribbonFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  varying float vT;
  varying float vSide;
  void main() {
    float across = 1.0 - vSide * vSide;
    float along = vT * vT;
    float a = across * along * uIntensity;
    if (a <= 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

export class TrailRibbon {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private geo: THREE.BufferGeometry;
  private pos: THREE.BufferAttribute;
  private prev: THREE.BufferAttribute;
  private samples: THREE.Vector3[] = [];
  private lastEmit = 0;

  constructor(
    private sampleCount = 72,
    private emitInterval = 0.05,
  ) {
    for (let i = 0; i < sampleCount; i++) this.samples.push(new THREE.Vector3());
    this.geo = new THREE.BufferGeometry();
    const vcount = sampleCount * 2;
    this.pos = new THREE.BufferAttribute(new Float32Array(vcount * 3), 3);
    this.prev = new THREE.BufferAttribute(new Float32Array(vcount * 3), 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.prev.setUsage(THREE.DynamicDrawUsage);
    const ts = new Float32Array(vcount);
    const sides = new Float32Array(vcount);
    const indices: number[] = [];
    for (let i = 0; i < sampleCount; i++) {
      const t = i / (sampleCount - 1);
      ts[i * 2] = t;
      ts[i * 2 + 1] = t;
      sides[i * 2] = -1;
      sides[i * 2 + 1] = 1;
      if (i < sampleCount - 1) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    this.geo.setAttribute('position', this.pos);
    this.geo.setAttribute('aPrev', this.prev);
    this.geo.setAttribute('aT', new THREE.BufferAttribute(ts, 1));
    this.geo.setAttribute('aSide', new THREE.BufferAttribute(sides, 1));
    this.geo.setIndex(indices);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    this.mat = new THREE.ShaderMaterial({
      vertexShader: ribbonVertex,
      fragmentShader: ribbonFragment,
      uniforms: {
        uAspect: { value: 16 / 9 },
        uWidth: { value: 0.01 },
        uColor: { value: new THREE.Color() },
        uIntensity: { value: 0 },
      },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
  }

  /** Sweep the whole trail through space (for fly-through worlds). */
  drift(dx: number, dy: number, dz: number): void {
    for (const s of this.samples) {
      s.x += dx;
      s.y += dy;
      s.z += dz;
    }
  }

  reset(point: THREE.Vector3, time: number): void {
    for (const s of this.samples) s.copy(point);
    this.lastEmit = time;
    this.write();
  }

  update(
    time: number,
    head: THREE.Vector3,
    color: THREE.Color,
    intensity: number,
    width: number,
    aspect: number,
  ): void {
    if (time - this.lastEmit >= this.emitInterval) {
      this.lastEmit = time;
      for (let i = 0; i < this.sampleCount - 1; i++) this.samples[i].copy(this.samples[i + 1]);
    }
    this.samples[this.sampleCount - 1].copy(head);
    this.write();
    this.mat.uniforms.uAspect.value = aspect;
    this.mat.uniforms.uWidth.value = width;
    this.mat.uniforms.uIntensity.value = intensity;
    (this.mat.uniforms.uColor.value as THREE.Color).copy(color);
  }

  private write(): void {
    for (let i = 0; i < this.sampleCount; i++) {
      const cur = this.samples[i];
      const prv = this.samples[Math.max(0, i - 1)];
      this.pos.setXYZ(i * 2, cur.x, cur.y, cur.z);
      this.pos.setXYZ(i * 2 + 1, cur.x, cur.y, cur.z);
      this.prev.setXYZ(i * 2, prv.x, prv.y, prv.z);
      this.prev.setXYZ(i * 2 + 1, prv.x, prv.y, prv.z);
    }
    this.pos.needsUpdate = true;
    this.prev.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
