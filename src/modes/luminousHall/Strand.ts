import * as THREE from 'three';

/**
 * One register's voice as an aurora strand: a continuous ribbon of light
 * hanging on the orchestra arc, undulating like a slow bow stroke. The
 * strand is one tessellated strip whose entire shape lives in the vertex
 * shader — the CPU only writes uniforms.
 *
 * Onsets travel outward along the strand as pulses of brightness.
 * The salient strand sharpens, brightens, and sheds fine rising sparks.
 * A dimmed mirror copy provides the floor reflection.
 */

const SEGMENTS = 140;
const MAX_PULSES = 4;
const SPARK_COUNT = 72;

const strandVertex = /* glsl */ `
  uniform float uTime;
  uniform vec3 uArcOrigin;
  uniform float uCenterAngle;
  uniform float uHalfAngle;
  uniform float uDist;
  uniform float uHeight;
  uniform float uThickness;
  uniform float uAmp;
  uniform float uSpeed;
  uniform float uPhase;
  uniform float uMirror;
  varying float vT;
  varying float vAcross;
  void main() {
    float t = position.x + 0.5;       // 0..1 along the strand
    float across = position.y * 2.0;  // -1..1 across thickness
    float ang = uCenterAngle + (t - 0.5) * 2.0 * uHalfAngle;

    // slow flag-like undulation; several incommensurate waves so the motion
    // never repeats and never snaps
    float w1 = sin(t * 7.3 + uTime * uSpeed + uPhase);
    float w2 = sin(t * 13.1 - uTime * uSpeed * 0.71 + uPhase * 2.3);
    float w3 = sin(t * 3.7 + uTime * uSpeed * 0.43 + uPhase * 4.1);
    float lift = uAmp * (w1 * 0.5 + w2 * 0.26 + w3 * 0.4);

    // the strand bows gently away with distance, thicker mid, tapered ends
    float taper = pow(sin(3.14159 * t), 0.65);
    float th = uThickness * taper * (0.75 + 0.25 * sin(t * 11.0 + uTime * 0.9 + uPhase));

    vec3 p;
    p.x = uArcOrigin.x + sin(ang) * uDist;
    p.z = uArcOrigin.z - cos(ang) * uDist
        + uAmp * 0.35 * sin(t * 9.7 + uTime * uSpeed * 0.8 + uPhase * 3.0);
    p.y = uHeight + lift + across * th;
    if (uMirror > 0.5) p.y = -p.y;

    vT = t;
    vAcross = across;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const strandFragment = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uPhase;
  uniform float uDefinition; // salience: 0 hazy .. 1 crisp
  uniform vec2 uPulses[${MAX_PULSES}]; // x = travelled distance 0..0.55, y = strength
  varying float vT;
  varying float vAcross;
  void main() {
    // soft body with a luminous core line; salience sharpens the core
    float body = pow(max(0.0, 1.0 - abs(vAcross)), 1.6) * 0.5;
    float core = exp(-vAcross * vAcross * mix(6.0, 14.0, uDefinition))
               * mix(0.45, 0.95, uDefinition);
    float ends = smoothstep(0.0, 0.06, vT) * smoothstep(1.0, 0.94, vT);

    // slow shimmer drifting along the strand — light is alive, never static
    float shimmer = 0.7
      + 0.3 * sin(vT * 19.0 - uTime * 1.1 + uPhase * 5.0)
            * sin(vT * 7.0 + uTime * 0.7 + uPhase);

    // onset pulses travelling outward from the strand's centre
    float d = abs(vT - 0.5);
    float pulse = 0.0;
    for (int i = 0; i < ${MAX_PULSES}; i++) {
      float pd = uPulses[i].x;
      float ps = uPulses[i].y;
      pulse += ps * exp(-pow((d - pd) * 16.0, 2.0));
    }

    float a = (body + core) * ends * shimmer * uIntensity * (1.0 + pulse * 1.6);
    if (a <= 0.004) discard;
    gl_FragColor = vec4(uColor * (1.0 + pulse * 0.5), a);
  }
`;

const sparkVertex = /* glsl */ `
  uniform float uTime;
  uniform vec3 uCenter;
  uniform float uSpreadX;
  uniform float uPx;
  attribute vec3 aSeed;
  attribute float aPhase;
  varying float vFade;
  void main() {
    float rise = fract(aPhase + uTime * mix(0.025, 0.06, aSeed.y));
    vec3 p = uCenter + vec3(
      (aSeed.x - 0.5) * uSpreadX,
      rise * 3.2 - 0.4 + sin(uTime * 0.4 + aPhase * 6.28318) * 0.2,
      (aSeed.z - 0.5) * 1.4
    );
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = mix(1.2, 2.6, aSeed.y) * uPx * (300.0 / max(1.0, -mv.z));
    vFade = sin(3.14159 * rise) * mix(0.4, 1.0, aSeed.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const sparkFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  varying float vFade;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv) * 2.0;
    float a = (exp(-d * d * 6.0) - 0.02) * vFade * uIntensity;
    if (a <= 0.003) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

function additive(m: THREE.ShaderMaterial): THREE.ShaderMaterial {
  m.blending = THREE.AdditiveBlending;
  m.transparent = true;
  m.depthWrite = false;
  return m;
}

interface Pulse {
  dist: number;
  strength: number;
}

export class Strand {
  readonly group = new THREE.Group();
  /** World-space centre of the strand (for camera lean targets). */
  readonly center = new THREE.Vector3();

  private mat: THREE.ShaderMaterial;
  private mirrorMat: THREE.ShaderMaterial;
  private sparkMat: THREE.ShaderMaterial;
  private mirror: THREE.Mesh;
  private pulses: Pulse[] = [];
  private pulseArray: Float32Array;
  private geometries: THREE.BufferGeometry[] = [];

  constructor(
    rng: () => number,
    private thicknessScale = 1,
  ) {
    const geo = new THREE.PlaneGeometry(1, 1, SEGMENTS, 1);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.pulseArray = new Float32Array(MAX_PULSES * 2);

    const makeMat = (mirrorFlag: number) => {
      const m = additive(
        new THREE.ShaderMaterial({
          vertexShader: strandVertex,
          fragmentShader: strandFragment,
          uniforms: {
            uTime: { value: 0 },
            uArcOrigin: { value: new THREE.Vector3() },
            uCenterAngle: { value: 0 },
            uHalfAngle: { value: 0.2 },
            uDist: { value: 20 },
            uHeight: { value: 4 },
            uThickness: { value: 0.5 },
            uAmp: { value: 0.8 },
            uSpeed: { value: 0.6 },
            uPhase: { value: rng() * 12.56 },
            uMirror: { value: mirrorFlag },
            uColor: { value: new THREE.Color() },
            uIntensity: { value: 0.05 },
            uDefinition: { value: 0 },
            uPulses: { value: this.pulseArray },
          },
          side: THREE.DoubleSide,
        }),
      );
      return m;
    };

    this.mat = makeMat(0);
    this.mirrorMat = makeMat(1);
    const mesh = new THREE.Mesh(geo, this.mat);
    this.mirror = new THREE.Mesh(geo, this.mirrorMat);
    mesh.frustumCulled = false;
    this.mirror.frustumCulled = false;

    // sparks
    const sparkGeo = new THREE.BufferGeometry();
    const sPos = new Float32Array(SPARK_COUNT * 3);
    const sSeed = new Float32Array(SPARK_COUNT * 3);
    const sPhase = new Float32Array(SPARK_COUNT);
    for (let i = 0; i < SPARK_COUNT; i++) {
      sSeed[i * 3] = rng();
      sSeed[i * 3 + 1] = rng();
      sSeed[i * 3 + 2] = rng();
      sPhase[i] = rng();
    }
    sparkGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
    sparkGeo.setAttribute('aSeed', new THREE.BufferAttribute(sSeed, 3));
    sparkGeo.setAttribute('aPhase', new THREE.BufferAttribute(sPhase, 1));
    sparkGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.sparkMat = additive(
      new THREE.ShaderMaterial({
        vertexShader: sparkVertex,
        fragmentShader: sparkFragment,
        uniforms: {
          uTime: { value: 0 },
          uCenter: { value: new THREE.Vector3() },
          uSpreadX: { value: 6 },
          uPx: { value: 1 },
          uColor: { value: new THREE.Color() },
          uIntensity: { value: 0 },
        },
      }),
    );
    const sparks = new THREE.Points(sparkGeo, this.sparkMat);
    sparks.frustumCulled = false;

    this.group.add(mesh, this.mirror, sparks);
    this.geometries.push(geo, sparkGeo);
  }

  /** Fire an onset pulse that travels outward from the strand's centre. */
  pulse(strength: number): void {
    if (this.pulses.length >= MAX_PULSES) return; // graceful, never strobing
    this.pulses.push({ dist: 0, strength: Math.min(1, 0.3 + strength * 0.8) });
  }

  update(
    time: number,
    dt: number,
    arcOrigin: THREE.Vector3,
    centerAngle: number,
    halfAngle: number,
    dist: number,
    height: number,
    color: THREE.Color,
    energy: number,
    intensity: number,
    salientLevel: number,
    flux: number,
    px: number,
  ): void {
    this.center.set(
      arcOrigin.x + Math.sin(centerAngle) * dist,
      height,
      arcOrigin.z - Math.cos(centerAngle) * dist,
    );

    // advance pulses
    for (const p of this.pulses) {
      p.dist += dt * 0.55;
      p.strength *= Math.exp(-dt * 2.4);
    }
    this.pulses = this.pulses.filter((p) => p.dist < 0.55 && p.strength > 0.02);
    this.pulseArray.fill(0);
    this.pulses.forEach((p, i) => {
      this.pulseArray[i * 2] = p.dist;
      this.pulseArray[i * 2 + 1] = p.strength;
    });

    for (const m of [this.mat, this.mirrorMat]) {
      const u = m.uniforms;
      u.uTime.value = time;
      (u.uArcOrigin.value as THREE.Vector3).copy(arcOrigin);
      u.uCenterAngle.value = centerAngle;
      u.uHalfAngle.value = halfAngle;
      u.uDist.value = dist;
      u.uHeight.value = height;
      // quiet strands hang slack and thin; loud ones billow tall and full
      u.uAmp.value = 0.45 + energy * 1.5;
      u.uSpeed.value = 0.35 + energy * 0.5 + flux * 0.5;
      u.uThickness.value = (0.22 + energy * 0.6) * (1 + salientLevel * 0.35) * this.thicknessScale;
      (u.uColor.value as THREE.Color).copy(color);
      u.uDefinition.value = salientLevel;
    }
    this.mat.uniforms.uIntensity.value = intensity;
    this.mirrorMat.uniforms.uIntensity.value = intensity * 0.26;

    // sparks: the salient voice sheds fine rising light
    const su = this.sparkMat.uniforms;
    su.uTime.value = time;
    (su.uCenter.value as THREE.Vector3).copy(this.center);
    su.uSpreadX.value = Math.max(2, Math.sin(halfAngle) * dist * 1.7);
    su.uPx.value = px;
    (su.uColor.value as THREE.Color).copy(color);
    su.uIntensity.value = (0.1 + energy * 0.45) * salientLevel;
  }

  setMirrorVisible(visible: boolean): void {
    this.mirror.visible = visible;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.mat.dispose();
    this.mirrorMat.dispose();
    this.sparkMat.dispose();
  }
}
