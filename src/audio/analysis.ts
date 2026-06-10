/**
 * AnalysisFrame producer. Reads the two per-channel analysers each animation
 * frame and distills them into the musical features every visualization mode
 * consumes. Modes never touch the Web Audio API — only this frame.
 */

import { AudioEngine, FFT_SIZE } from './engine';
import { AdaptiveMax, EnvelopeFollower, clamp01, clamp } from './smoothing';

export const BAND_COUNT = 5;
export const BAND_NAMES = ['bass', 'tenor', 'alto', 'soprano', 'brilliance'] as const;

/** Musical register edges in Hz. */
const BAND_EDGES = [30, 250, 700, 1800, 4500, 12000];

export interface BandFrame {
  /** Perceptually scaled, normalized loudness 0..1 (attack/release smoothed). */
  energy: number;
  /** Fast, lightly smoothed energy — for things that must twitch (ripples). */
  energyFast: number;
  /** Stereo position -1 (left) .. 1 (right), smoothed. */
  pan: number;
  /** True on the frame an onset is detected in this band. */
  attack: boolean;
  /** Onset strength 0..1 (decays after the attack frame). */
  attackStrength: number;
  /** Dominant in-band frequency, normalized 0..1 across the band's range. */
  pitch: number;
}

export interface AnalysisFrame {
  bands: BandFrame[];
  /** Total loudness, fast envelope (0..1). */
  energyFast: number;
  /** Total loudness, slow envelope (0..1) — crescendos read here. */
  energySlow: number;
  /** Signed loudness trend per second: + building, - receding. */
  energyDeriv: number;
  /** Spectral centroid mapped 0..1 (dark .. brilliant). */
  centroid: number;
  /** Spectral flux 0..1 — how busy/textured the moment is. */
  flux: number;
  /** Broadband onset strength 0..1. */
  onset: number;
  /** Crude stereo width 0 (mono) .. 1 (wide/decorrelated). */
  stereoWidth: number;
  /** Index of the band currently carrying the musical foreground. */
  salientBand: number;
  /** Confidence in that choice, 0..1. */
  salience: number;
  /** Number of bands above an audibility threshold (texture density). */
  activeBands: number;
  /** True while transport is actually playing. */
  playing: boolean;
}

export function emptyFrame(): AnalysisFrame {
  return {
    bands: Array.from({ length: BAND_COUNT }, () => ({
      energy: 0,
      energyFast: 0,
      pan: 0,
      attack: false,
      attackStrength: 0,
      pitch: 0.5,
    })),
    energyFast: 0,
    energySlow: 0,
    energyDeriv: 0,
    centroid: 0,
    flux: 0,
    onset: 0,
    stereoWidth: 0,
    salientBand: 2,
    salience: 0,
    activeBands: 0,
    playing: false,
  };
}

/** Salience: a challenger must beat the incumbent by this factor… */
const SALIENCE_MARGIN = 1.2;
/** …sustained for this long, before attention moves. */
const SALIENCE_HOLD_MS = 300;
/** Weight per band: melody usually lives in the upper-middle registers. */
const SALIENCE_WEIGHT = [0.55, 0.85, 1.05, 1.2, 0.9];

const DYN_RANGE_DB = 38; // visual dynamic range below the adaptive ceiling
const NOISE_FLOOR_DB = -78; // below this a band is considered silent

export class AnalysisProducer {
  private engine: AudioEngine;
  private freqL = new Float32Array(FFT_SIZE / 2);
  private freqR = new Float32Array(FFT_SIZE / 2);
  private timeL = new Float32Array(FFT_SIZE);
  private timeR = new Float32Array(FFT_SIZE);
  private prevMag: Float32Array; // linear magnitudes (L+R) for flux
  private binLo: number[] = [];
  private binHi: number[] = [];
  private nyquistBins: number;

  // per-band state
  private bandMax: AdaptiveMax[] = [];
  private bandEnv: EnvelopeFollower[] = [];
  private bandEnvFast: EnvelopeFollower[] = [];
  private bandLongEnv: EnvelopeFollower[] = [];
  private bandPan: EnvelopeFollower[] = [];
  private bandPitch: EnvelopeFollower[] = [];
  private bandAttackDecay: number[] = new Array(BAND_COUNT).fill(0);
  private bandAttackCooldown: number[] = new Array(BAND_COUNT).fill(0);

  // global state
  private globalMax = new AdaptiveMax(NOISE_FLOOR_DB + 26, 1200, 30000);
  private envFast = new EnvelopeFollower(40, 280);
  private envSlow = new EnvelopeFollower(450, 1400);
  private derivSmooth = new EnvelopeFollower(220, 220);
  private centroidEnv = new EnvelopeFollower(120, 600);
  private fluxEnv = new EnvelopeFollower(60, 500);
  private fluxMax = new AdaptiveMax(0.5, 2000, 30000);
  private onsetDecay = 0;
  private widthEnv = new EnvelopeFollower(300, 1200);
  private salienceEnv = new EnvelopeFollower(250, 900);
  private prevEnergySlow = 0;

  // salience hysteresis
  private incumbent = 2;
  private challenger = -1;
  private challengerMs = 0;

  readonly frame: AnalysisFrame = emptyFrame();

  constructor(engine: AudioEngine) {
    this.engine = engine;
    const sampleRate = engine.ctx.sampleRate;
    const binHz = sampleRate / FFT_SIZE;
    this.nyquistBins = FFT_SIZE / 2;
    for (let b = 0; b < BAND_COUNT; b++) {
      this.binLo.push(Math.max(1, Math.round(BAND_EDGES[b] / binHz)));
      this.binHi.push(Math.min(this.nyquistBins - 1, Math.round(BAND_EDGES[b + 1] / binHz)));
      this.bandMax.push(new AdaptiveMax(NOISE_FLOOR_DB + 22, 1500, 25000));
      this.bandEnv.push(new EnvelopeFollower(50, 800));
      this.bandEnvFast.push(new EnvelopeFollower(18, 120));
      this.bandLongEnv.push(new EnvelopeFollower(900, 900));
      this.bandPan.push(new EnvelopeFollower(180, 320));
      this.bandPitch.push(new EnvelopeFollower(350, 700, 0.5));
    }
    this.prevMag = new Float32Array(this.nyquistBins);
  }

  /** Produce the next AnalysisFrame. dtMs = elapsed ms since last call. */
  update(dtMs: number): AnalysisFrame {
    const f = this.frame;
    f.playing = this.engine.isPlaying;

    this.engine.analyserL.getFloatFrequencyData(this.freqL);
    this.engine.analyserR.getFloatFrequencyData(this.freqR);

    // ---- per-band features -------------------------------------------------
    let activeBands = 0;
    let totalPower = 0;
    let centroidNum = 0;
    let centroidDen = 0;
    let flux = 0;

    // single pass over all bins for centroid + flux on summed magnitudes
    for (let i = 1; i < this.nyquistBins; i++) {
      const pl = dbToPower(this.freqL[i]);
      const pr = dbToPower(this.freqR[i]);
      const p = pl + pr;
      const mag = Math.sqrt(p);
      const d = mag - this.prevMag[i];
      if (d > 0) flux += d;
      this.prevMag[i] = mag;
      centroidNum += i * p;
      centroidDen += p;
    }

    const scoreBase: number[] = [];
    for (let b = 0; b < BAND_COUNT; b++) {
      let pL = 0;
      let pR = 0;
      let peakP = 0;
      let peakBin = this.binLo[b];
      for (let i = this.binLo[b]; i <= this.binHi[b]; i++) {
        const l = dbToPower(this.freqL[i]);
        const r = dbToPower(this.freqR[i]);
        pL += l;
        pR += r;
        const p = l + r;
        if (p > peakP) {
          peakP = p;
          peakBin = i;
        }
      }
      const p = pL + pR;
      totalPower += p;

      // perceptual (dB) scale, normalized against a slow-adapting ceiling
      const db = powerToDb(p);
      const ceiling = this.bandMax[b].process(db, dtMs);
      const raw = clamp01(1 + (db - ceiling) / DYN_RANGE_DB);
      const band = f.bands[b];

      band.energy = this.bandEnv[b].process(raw, dtMs);
      band.energyFast = this.bandEnvFast[b].process(raw, dtMs);
      const longEnv = this.bandLongEnv[b].process(raw, dtMs);

      // onset: fast envelope jumps well above the long-window envelope
      this.bandAttackCooldown[b] = Math.max(0, this.bandAttackCooldown[b] - dtMs);
      const jump = band.energyFast - longEnv;
      const isAttack =
        jump > 0.13 && band.energyFast > 0.12 && this.bandAttackCooldown[b] <= 0;
      band.attack = isAttack;
      if (isAttack) {
        this.bandAttackDecay[b] = Math.min(1, jump * 3);
        this.bandAttackCooldown[b] = 90; // refractory so rolls read as pulses
      } else {
        this.bandAttackDecay[b] *= Math.exp(-dtMs / 180);
      }
      band.attackStrength = this.bandAttackDecay[b];

      // pan from L/R energy ratio; hold last pan when the band is silent
      if (db > NOISE_FLOOR_DB) {
        const panRaw = (pR - pL) / (pR + pL + 1e-12);
        band.pan = this.bandPan[b].process(clamp(panRaw * 1.1, -1, 1), dtMs);
      }

      // dominant in-band frequency, normalized within the band (log-ish feel
      // is fine linearly at this granularity)
      if (band.energy > 0.06) {
        const t = (peakBin - this.binLo[b]) / Math.max(1, this.binHi[b] - this.binLo[b]);
        band.pitch = this.bandPitch[b].process(t, dtMs);
      }

      if (band.energy > 0.12) activeBands++;
      scoreBase.push(band.energy);
    }
    f.activeBands = activeBands;

    // ---- global features ---------------------------------------------------
    const totalDb = powerToDb(totalPower);
    const gCeiling = this.globalMax.process(totalDb, dtMs);
    const gRaw = clamp01(1 + (totalDb - gCeiling) / DYN_RANGE_DB);
    f.energyFast = this.envFast.process(gRaw, dtMs);
    const slow = this.envSlow.process(gRaw, dtMs);
    const derivRaw = (slow - this.prevEnergySlow) / Math.max(dtMs / 1000, 1e-3);
    this.prevEnergySlow = slow;
    f.energySlow = slow;
    f.energyDeriv = this.derivSmooth.process(clamp(derivRaw, -1.5, 1.5), dtMs);

    const centroidBin = centroidDen > 1e-10 ? centroidNum / centroidDen : 0;
    // map bin -> 0..1 over the musically useful range (~30 Hz .. 8 kHz)
    const centroidHz = (centroidBin / this.nyquistBins) * (this.engine.ctx.sampleRate / 2);
    const centroidT = clamp01(Math.log2(Math.max(centroidHz, 40) / 200) / 5.3);
    f.centroid = this.centroidEnv.process(centroidT, dtMs);

    const fluxCeil = this.fluxMax.process(flux, dtMs);
    f.flux = this.fluxEnv.process(clamp01(flux / (fluxCeil + 1e-6)), dtMs);

    // broadband onset = strongest band attack this frame, with decay
    let onsetNow = 0;
    for (let b = 0; b < BAND_COUNT; b++) {
      if (f.bands[b].attack) onsetNow = Math.max(onsetNow, f.bands[b].attackStrength);
    }
    this.onsetDecay = Math.max(onsetNow, this.onsetDecay * Math.exp(-dtMs / 150));
    f.onset = this.onsetDecay;

    f.stereoWidth = this.widthEnv.process(this.measureWidth(), dtMs);

    // ---- salience: who carries the melody ----------------------------------
    this.updateSalience(f, scoreBase, dtMs);

    return f;
  }

  private measureWidth(): number {
    this.engine.analyserL.getFloatTimeDomainData(this.timeL);
    this.engine.analyserR.getFloatTimeDomainData(this.timeR);
    // normalized cross-correlation at lag 0, decimated for cheapness
    let sLL = 0;
    let sRR = 0;
    let sLR = 0;
    for (let i = 0; i < FFT_SIZE; i += 4) {
      const l = this.timeL[i];
      const r = this.timeR[i];
      sLL += l * l;
      sRR += r * r;
      sLR += l * r;
    }
    if (sLL < 1e-8 || sRR < 1e-8) return 0;
    const corr = sLR / Math.sqrt(sLL * sRR);
    return clamp01(1 - corr);
  }

  private updateSalience(f: AnalysisFrame, energies: number[], dtMs: number): void {
    // score = energy, weighted toward upper registers and recent onsets
    const scores = energies.map(
      (e, b) => e * SALIENCE_WEIGHT[b] * (1 + 0.5 * f.bands[b].attackStrength),
    );

    let best = 0;
    for (let b = 1; b < BAND_COUNT; b++) if (scores[b] > scores[best]) best = b;

    const incumbentScore = scores[this.incumbent];
    if (best !== this.incumbent && scores[best] > incumbentScore * SALIENCE_MARGIN) {
      if (this.challenger === best) {
        this.challengerMs += dtMs;
        if (this.challengerMs >= SALIENCE_HOLD_MS) {
          this.incumbent = best;
          this.challenger = -1;
          this.challengerMs = 0;
        }
      } else {
        this.challenger = best;
        this.challengerMs = dtMs;
      }
    } else {
      this.challenger = -1;
      this.challengerMs = 0;
    }

    f.salientBand = this.incumbent;

    // confidence: lead of the incumbent over the runner-up, gated by loudness
    let second = 0;
    for (let b = 0; b < BAND_COUNT; b++) {
      if (b !== this.incumbent) second = Math.max(second, scores[b]);
    }
    const lead = scores[this.incumbent] > 1e-4 ? 1 - second / scores[this.incumbent] : 0;
    const conf = clamp01(lead * 1.6) * clamp01(energies[this.incumbent] * 3);
    f.salience = this.salienceEnv.process(conf, dtMs);
  }
}

function dbToPower(db: number): number {
  // analyser returns -Infinity for silence
  if (db <= -180 || !isFinite(db)) return 0;
  return Math.pow(10, db / 10);
}

function powerToDb(p: number): number {
  return 10 * Math.log10(p + 1e-12);
}
