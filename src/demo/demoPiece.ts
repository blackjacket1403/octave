/**
 * "Study in D minor" — a ~45 second demo piece rendered offline with
 * oscillators, written specifically to exercise every visual mapping:
 * a low pedal (bass altitude), call-and-response melody panned hard
 * left/right (pan + salience handoff), a long central crescendo
 * (approach), shimmer 16ths (brilliance + density), timpani strokes
 * (onset ripples), and a fading coda (recession + cooling).
 */

const SR = 44100;
const DURATION = 46;

interface NoteOpts {
  t: number; // start time (s)
  dur: number; // sustain length (s)
  freq: number;
  gain: number;
  pan?: number; // -1..1
  type?: OscillatorType;
  attack?: number;
  release?: number;
  vibrato?: number; // Hz depth (cents-ish via detune)
  lowpass?: number;
  /** second oscillator one octave up, blended quietly, for body */
  octave?: number;
}

function note(ctx: OfflineAudioContext, dest: AudioNode, o: NoteOpts): void {
  const attack = o.attack ?? 0.03;
  const release = o.release ?? 0.35;
  const end = o.t + o.dur + release;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, o.t);
  gain.gain.linearRampToValueAtTime(o.gain, o.t + attack);
  gain.gain.setValueAtTime(o.gain, o.t + o.dur);
  gain.gain.exponentialRampToValueAtTime(0.0008, end);

  const pan = ctx.createStereoPanner();
  pan.pan.value = o.pan ?? 0;

  let chainHead: AudioNode = gain;
  if (o.lowpass) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = o.lowpass;
    gain.connect(lp);
    chainHead = lp;
  }
  chainHead.connect(pan);
  pan.connect(dest);

  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'triangle';
  osc.frequency.value = o.freq;
  if (o.vibrato) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.2;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = o.vibrato;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.detune);
    lfo.start(o.t + 0.15);
    lfo.stop(end);
  }
  osc.connect(gain);
  osc.start(o.t);
  osc.stop(end);

  if (o.octave) {
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = o.freq * 2;
    const g2 = ctx.createGain();
    g2.gain.value = o.octave;
    osc2.connect(g2);
    g2.connect(gain);
    osc2.start(o.t);
    osc2.stop(end);
  }
}

/** Timpani-ish stroke: sine pitch drop plus a filtered noise thump. */
function timpani(ctx: OfflineAudioContext, dest: AudioNode, t: number, gainVal: number): void {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(95, t);
  osc.frequency.exponentialRampToValueAtTime(52, t + 0.35);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gainVal, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
  osc.connect(g);
  g.connect(dest);
  osc.start(t);
  osc.stop(t + 1);

  const noiseLen = Math.floor(SR * 0.18);
  const nb = ctx.createBuffer(1, noiseLen, SR);
  const nd = nb.getChannelData(0);
  for (let i = 0; i < noiseLen; i++) nd[i] = (Math.random() * 2 - 1) * (1 - i / noiseLen);
  const noise = ctx.createBufferSource();
  noise.buffer = nb;
  const nf = ctx.createBiquadFilter();
  nf.type = 'lowpass';
  nf.frequency.value = 220;
  const ng = ctx.createGain();
  ng.gain.value = gainVal * 0.5;
  noise.connect(nf);
  nf.connect(ng);
  ng.connect(dest);
  noise.start(t);
}

/** Simple generated hall: exponentially decaying noise as a convolver IR. */
function makeReverb(ctx: OfflineAudioContext): ConvolverNode {
  const len = Math.floor(SR * 2.2);
  const ir = ctx.createBuffer(2, len, SR);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
  }
  const conv = ctx.createConvolver();
  conv.buffer = ir;
  return conv;
}

// D natural minor frequencies
const N = {
  D2: 73.42, E2: 82.41, F2: 87.31, G2: 98.0, A2: 110.0,
  D3: 146.83, F3: 174.61, G3: 196.0, A3: 220.0, Bb3: 233.08, C4: 261.63, Cs4: 277.18, D4: 293.66, E4: 329.63, F4: 349.23,
  A4: 440.0, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0, Bb5: 932.33, C6: 1046.5,
  D6: 1174.66, E6: 1318.51, F6: 1396.91, A6: 1760.0, F6b: 1396.91, D7: 2349.32,
};

export async function renderDemoPiece(): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, SR * DURATION, SR);

  const master = ctx.createDynamicsCompressor();
  master.threshold.value = -14;
  master.ratio.value = 5;
  master.connect(ctx.destination);

  const reverb = makeReverb(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.32;
  reverb.connect(wet);
  wet.connect(master);

  const dry = ctx.createGain();
  dry.gain.value = 0.9;
  dry.connect(master);
  dry.connect(reverb);

  const out = dry; // every voice feeds dry + hall

  const bass = (t: number, dur: number, freq: number, g = 0.30, pan = 0.18) =>
    note(ctx, out, { t, dur, freq, gain: g, pan, type: 'triangle', lowpass: 300, attack: 0.05, release: 0.5, octave: 0.18 });

  const melody = (t: number, dur: number, freq: number, g: number, pan: number) =>
    note(ctx, out, { t, dur, freq, gain: g, pan, type: 'triangle', vibrato: 14, attack: 0.025, release: 0.32, octave: 0.3 });

  const pad = (t: number, dur: number, freqs: number[], g: number, pan = 0) => {
    for (const f of freqs)
      note(ctx, out, { t, dur, freq: f, gain: g, pan, type: 'sawtooth', lowpass: 750, attack: 0.9, release: 1.4 });
  };

  const shimmer = (t: number, freq: number, g: number, pan: number) =>
    note(ctx, out, { t, dur: 0.1, freq, gain: g, pan, type: 'triangle', attack: 0.008, release: 0.12 });

  // ---------- 0–6s: the hall breathes — low pedal swells out of silence ----
  note(ctx, out, { t: 0.4, dur: 5.0, freq: N.D2, gain: 0.26, pan: 0.2, type: 'triangle', lowpass: 240, attack: 2.8, release: 1.2, octave: 0.12 });
  timpani(ctx, out, 5.2, 0.30);

  // ---------- 6–18s: call (hard left) and response (hard right) ------------
  // phrase 1 — left
  melody(6.0, 0.9, N.D5, 0.20, -0.75);
  melody(7.0, 0.42, N.F5, 0.21, -0.75);
  melody(7.5, 0.42, N.E5, 0.20, -0.75);
  melody(8.0, 0.9, N.D5, 0.20, -0.75);
  melody(9.0, 1.5, N.A4, 0.18, -0.75);
  // phrase 2 — answered from the right
  melody(11.0, 0.9, N.F5, 0.21, 0.75);
  melody(12.0, 0.42, N.A5, 0.22, 0.75);
  melody(12.5, 0.42, N.G5, 0.21, 0.75);
  melody(13.0, 0.9, N.F5, 0.20, 0.75);
  melody(14.0, 1.5, N.E5, 0.19, 0.75);
  // phrase 3 — handed back, travelling left to centre
  melody(16.0, 0.45, N.D5, 0.20, -0.6);
  melody(16.5, 0.45, N.E5, 0.20, -0.3);
  melody(17.0, 0.9, N.F5, 0.21, 0.0);

  // gentle bass quarters under the dialogue
  for (let i = 0; i < 6; i++) bass(6 + i * 2, 1.2, i % 2 === 0 ? N.D2 : N.A2, 0.22);

  // ---------- 14–26s: mid-register pads enter (tenor/alto bodies wake) -----
  pad(14, 5.5, [N.D3, N.F3, N.A3], 0.045);
  pad(20, 5.5, [N.G3, N.Bb3, N.D4], 0.05);

  // ---------- 24–34s: the long crescendo — light approaches ----------------
  const cresc = ctx.createGain();
  cresc.gain.setValueAtTime(0.30, 24);
  cresc.gain.linearRampToValueAtTime(1.0, 33);
  cresc.gain.setValueAtTime(1.0, 37);
  cresc.gain.linearRampToValueAtTime(0.25, 43);
  cresc.connect(dry);

  const cOut = cresc;
  const cMelody = (t: number, dur: number, freq: number, g: number, pan: number) =>
    note(ctx, cOut, { t, dur, freq, gain: g, pan, type: 'triangle', vibrato: 16, attack: 0.02, release: 0.3, octave: 0.32 });
  const cBass = (t: number, dur: number, freq: number) =>
    note(ctx, cOut, { t, dur, freq, gain: 0.34, pan: 0.18, type: 'triangle', lowpass: 320, attack: 0.04, release: 0.4, octave: 0.2 });

  // climbing line, gathering speed
  const climb: [number, number, number][] = [
    [24.0, 1.1, N.D5], [25.2, 1.1, N.E5], [26.4, 0.9, N.F5], [27.4, 0.9, N.G5],
    [28.3, 0.75, N.A5], [29.1, 0.75, N.Bb5], [29.9, 0.6, N.C6], [30.5, 0.6, N.D6],
    [31.1, 0.5, N.C6], [31.6, 0.5, N.D6], [32.1, 0.45, N.E6], [32.6, 0.45, N.D6],
  ];
  for (const [t, d, f] of climb) cMelody(t, d, f, 0.22, Math.sin(t * 0.9) * 0.25);

  // walking bass and pads thickening underneath
  const walk = [N.D2, N.E2, N.F2, N.G2, N.A2, N.A2, N.G2, N.F2, N.E2, N.D2];
  for (let i = 0; i < walk.length; i++) cBass(24 + i * 0.9, 0.6, walk[i]);
  pad(26, 4.5, [N.D3, N.F3, N.A3, N.D4], 0.05);
  pad(30, 3.2, [N.A3, N.Cs4, N.E4], 0.06); // dominant: tension before the peak

  // shimmer 16ths — the brilliance body wakes, alternating ears
  const arp = [N.D6, N.A6, N.F6, N.D7];
  for (let i = 0; i < 56; i++) {
    const t = 28 + i * 0.16;
    if (t > 36.8) break;
    shimmer(t, arp[i % 4], 0.022 + Math.min(0.05, i * 0.0012), i % 2 === 0 ? -0.5 : 0.5);
  }

  // ---------- 33–37s: climax ------------------------------------------------
  timpani(ctx, out, 33.0, 0.55);
  timpani(ctx, out, 34.5, 0.5);
  timpani(ctx, out, 36.0, 0.6);
  cMelody(33.0, 0.9, N.D6, 0.26, 0);
  cMelody(34.0, 0.7, N.F6, 0.27, -0.2);
  cMelody(34.8, 0.7, N.E6, 0.26, 0.2);
  cMelody(35.6, 1.4, N.D6, 0.26, 0);
  pad(33, 4.0, [N.D3, N.F3, N.A3, N.D4, N.F4], 0.065);
  cBass(33.0, 1.4, N.D2);
  cBass(34.5, 1.4, N.D2);
  cBass(36.0, 1.8, N.D2);

  // ---------- 37–46s: diminuendo — the hall cools ---------------------------
  melody(38.5, 1.0, N.A5, 0.13, -0.3);
  melody(39.7, 1.0, N.F5, 0.11, -0.15);
  melody(41.0, 1.0, N.E5, 0.09, 0.0);
  melody(42.3, 2.6, N.D5, 0.08, 0.0);
  note(ctx, out, { t: 38, dur: 6.5, freq: N.D2, gain: 0.18, pan: 0.18, type: 'triangle', lowpass: 240, attack: 1.5, release: 1.8, octave: 0.1 });

  return ctx.startRendering();
}
