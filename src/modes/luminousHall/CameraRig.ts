import * as THREE from 'three';
import { clamp, smoothK } from '../../audio/smoothing';

/**
 * First-person camera at the conductor's podium. Fixed position with slow
 * breathing motion, a subtle lean toward the salient voice, and optional
 * drag-to-look (±40° yaw). Never cuts, never moves fast.
 */

const BASE_POS = new THREE.Vector3(0, 2.5, 9.5);
const BASE_PITCH = 0.10; // slight upward gaze toward the bodies
const MAX_LEAN_YAW = THREE.MathUtils.degToRad(6);
const MAX_LEAN_PITCH = THREE.MathUtils.degToRad(3.5);
const MAX_LOOK_YAW = THREE.MathUtils.degToRad(40);
const MAX_LOOK_PITCH = THREE.MathUtils.degToRad(22);

export class CameraRig {
  private camera!: THREE.PerspectiveCamera;
  private time = 0;

  private leanYaw = 0;
  private leanPitch = 0;
  private leanTargetYaw = 0;
  private leanTargetPitch = 0;

  private lookYaw = 0;
  private lookPitch = 0;
  private lookTargetYaw = 0;
  private lookTargetPitch = 0;

  private euler = new THREE.Euler(0, 0, 0, 'YXZ');

  init(camera: THREE.PerspectiveCamera): void {
    this.camera = camera;
    camera.position.copy(BASE_POS);
    camera.rotation.set(BASE_PITCH, 0, 0);
  }

  /** Aim the slow lean at a world position, weighted by salience confidence. */
  setLeanTarget(target: THREE.Vector3 | null, weight: number): void {
    if (!target || weight <= 0.02) {
      this.leanTargetYaw = 0;
      this.leanTargetPitch = 0;
      return;
    }
    const dx = target.x - BASE_POS.x;
    const dz = target.z - BASE_POS.z;
    const dy = target.y - BASE_POS.y;
    const yawTo = Math.atan2(-dx, -dz); // yaw that would face the body
    const pitchTo = Math.atan2(dy, Math.hypot(dx, dz)) - BASE_PITCH;
    this.leanTargetYaw = clamp(yawTo * 0.35, -MAX_LEAN_YAW, MAX_LEAN_YAW) * weight;
    this.leanTargetPitch = clamp(pitchTo * 0.25, -MAX_LEAN_PITCH, MAX_LEAN_PITCH) * weight;
  }

  /** Drag-to-look offsets in -1..1 (mapped to ±40° / ±22°). */
  setLook(x: number, y: number): void {
    this.lookTargetYaw = clamp(x, -1, 1) * MAX_LOOK_YAW;
    this.lookTargetPitch = clamp(y, -1, 1) * MAX_LOOK_PITCH;
  }

  update(dt: number, breathDepth: number): void {
    this.time += dt;
    const t = this.time;
    const dtMs = dt * 1000;

    // breathing: incommensurate sine periods so the loop never reads as a loop
    const breathe = 0.6 + breathDepth * 0.5;
    const px = Math.sin(t * (Math.PI * 2 / 17)) * 0.10 * breathe;
    const py = Math.sin(t * (Math.PI * 2 / 11)) * 0.05 * breathe;
    const pz = Math.sin(t * (Math.PI * 2 / 23)) * 0.16 * breathe;

    this.camera.position.set(BASE_POS.x + px, BASE_POS.y + py, BASE_POS.z + pz);

    // lean drifts over ~2.5s; look responds over ~0.4s
    const kLean = smoothK(2500, dtMs);
    this.leanYaw += (this.leanTargetYaw - this.leanYaw) * kLean;
    this.leanPitch += (this.leanTargetPitch - this.leanPitch) * kLean;
    const kLook = smoothK(400, dtMs);
    this.lookYaw += (this.lookTargetYaw - this.lookYaw) * kLook;
    this.lookPitch += (this.lookTargetPitch - this.lookPitch) * kLook;

    const swayYaw = Math.sin(t * (Math.PI * 2 / 29)) * 0.012 * breathe;

    this.euler.set(
      BASE_PITCH + this.leanPitch + this.lookPitch,
      this.leanYaw + this.lookYaw + swayYaw,
      Math.sin(t * (Math.PI * 2 / 31)) * 0.004,
    );
    this.camera.quaternion.setFromEuler(this.euler);
  }
}
