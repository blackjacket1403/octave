/**
 * AudioContext graph and playback control.
 *
 * Graph:  BufferSource -> master Gain -> destination
 *                                \-> ChannelSplitter -> AnalyserNode (L)
 *                                                    -> AnalyserNode (R)
 *
 * Mono sources are upmixed to stereo at decode time so the L/R analysers
 * always see a signal and pan math never divides by silence.
 */

export const FFT_SIZE = 4096;

export interface EngineEvents {
  onEnded?: () => void;
  onStateChange?: (playing: boolean) => void;
}

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly analyserL: AnalyserNode;
  readonly analyserR: AnalyserNode;

  private masterGain: GainNode;
  private splitter: ChannelSplitterNode;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;

  private startedAtCtxTime = 0; // ctx.currentTime when playback began
  private offsetSec = 0; // position within the buffer at playback start
  private playing = false;
  private events: EngineEvents;

  constructor(events: EngineEvents = {}) {
    this.events = events;
    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.9;
    this.splitter = this.ctx.createChannelSplitter(2);

    this.analyserL = this.ctx.createAnalyser();
    this.analyserR = this.ctx.createAnalyser();
    for (const a of [this.analyserL, this.analyserR]) {
      a.fftSize = FFT_SIZE;
      a.smoothingTimeConstant = 0; // smoothing is ours, in the analysis layer
      a.minDecibels = -100;
      a.maxDecibels = -10;
    }

    this.masterGain.connect(this.ctx.destination);
    this.masterGain.connect(this.splitter);
    this.splitter.connect(this.analyserL, 0);
    this.splitter.connect(this.analyserR, 1);
  }

  async decodeFile(file: File): Promise<AudioBuffer> {
    const data = await file.arrayBuffer();
    const decoded = await this.ctx.decodeAudioData(data);
    return this.toStereo(decoded);
  }

  /** Duplicate a mono channel so both analysers always receive signal. */
  private toStereo(buf: AudioBuffer): AudioBuffer {
    if (buf.numberOfChannels >= 2) return buf;
    const out = this.ctx.createBuffer(2, buf.length, buf.sampleRate);
    const mono = buf.getChannelData(0);
    out.copyToChannel(mono, 0);
    out.copyToChannel(mono, 1);
    return out;
  }

  /** Load a decoded buffer (from a file or the synthesized demo). */
  load(buffer: AudioBuffer): void {
    this.stopSource();
    this.buffer = this.toStereo(buffer);
    this.offsetSec = 0;
    this.playing = false;
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  get currentTime(): number {
    if (!this.buffer) return 0;
    if (!this.playing) return this.offsetSec;
    const t = this.offsetSec + (this.ctx.currentTime - this.startedAtCtxTime);
    return Math.min(t, this.buffer.duration);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get hasTrack(): boolean {
    return this.buffer !== null;
  }

  async play(): Promise<void> {
    if (!this.buffer || this.playing) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (this.offsetSec >= this.buffer.duration - 0.05) this.offsetSec = 0;

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.masterGain);
    src.onended = () => {
      // Only treat as "track finished" if this source is still live
      // (pause/seek detach onended before stopping).
      if (this.source === src && this.playing) {
        this.playing = false;
        this.offsetSec = this.buffer ? this.buffer.duration : 0;
        this.source = null;
        this.events.onEnded?.();
        this.events.onStateChange?.(false);
      }
    };
    src.start(0, this.offsetSec);
    this.source = src;
    this.startedAtCtxTime = this.ctx.currentTime;
    this.playing = true;
    this.events.onStateChange?.(true);
  }

  pause(): void {
    if (!this.playing) return;
    this.offsetSec = this.currentTime;
    this.stopSource();
    this.playing = false;
    this.events.onStateChange?.(false);
  }

  async toggle(): Promise<void> {
    if (this.playing) this.pause();
    else await this.play();
  }

  seek(timeSec: number): void {
    if (!this.buffer) return;
    const wasPlaying = this.playing;
    this.stopSource();
    this.playing = false;
    this.offsetSec = Math.max(0, Math.min(timeSec, this.buffer.duration));
    if (wasPlaying) void this.play();
  }

  setVolume(v: number): void {
    this.masterGain.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.05);
  }

  private stopSource(): void {
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        /* already stopped */
      }
      this.source.disconnect();
      this.source = null;
    }
  }
}
