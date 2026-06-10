/**
 * The UI shell: landing, drop zone, transport, mode picker, fullscreen,
 * auto-hide. Pure DOM — talks to the app through a small callback surface.
 */

import { modeRegistry } from '../modes/registry';

export interface UICallbacks {
  onFile(file: File): void;
  onDemo(): void;
  onTrackUrl(url: string, name: string): void;
  onTogglePlay(): void;
  onSeek(fraction: number): void;
  onVolume(v: number): void;
  onModeChange(id: string): void;
}

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

export class UI {
  private landing = $<HTMLDivElement>('#landing');
  private dropzone = $<HTMLDivElement>('#dropzone');
  private dragveil = $<HTMLDivElement>('#dragveil');
  private demoBtn = $<HTMLButtonElement>('#demoBtn');
  private transport = $<HTMLDivElement>('#transport');
  private playBtn = $<HTMLButtonElement>('#playBtn');
  private seek = $<HTMLDivElement>('#seek');
  private seekFill = $<HTMLDivElement>('#seek .fill');
  private seekKnob = $<HTMLDivElement>('#seek .knob');
  private timeNow = $<HTMLSpanElement>('#timeNow');
  private timeTotal = $<HTMLSpanElement>('#timeTotal');
  private trackName = $<HTMLDivElement>('#trackName');
  private vol = $<HTMLInputElement>('#vol');
  private fsBtn = $<HTMLButtonElement>('#fsBtn');
  private modeSelect = $<HTMLSelectElement>('#modeSelect');
  private fileInput = $<HTMLInputElement>('#fileInput');
  private toast = $<HTMLDivElement>('#toast');
  private devOverlay = $<HTMLDivElement>('#devOverlay');

  private idleTimer = 0;
  private playing = false;
  private toastTimer = 0;

  constructor(private cb: UICallbacks) {
    this.populateModes();
    this.wireLanding();
    this.wireTransport();
    this.wireIdleHide();

    // touch devices: no drag-and-drop, no Fullscreen API on iPhone
    if (window.matchMedia('(pointer: coarse)').matches) {
      const main = this.dropzone.querySelector('.dz-main');
      const sub = this.dropzone.querySelector('.dz-sub');
      if (main) main.textContent = 'Tap to choose a recording';
      if (sub) sub.textContent = 'mp3 · flac · wav · ogg';
    }
    if (!document.fullscreenEnabled) this.fsBtn.style.display = 'none';
  }

  private populateModes(): void {
    for (const m of modeRegistry) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.available ? m.name : `${m.name} — soon`;
      opt.disabled = !m.available;
      opt.title = m.description;
      this.modeSelect.appendChild(opt);
    }
    this.modeSelect.addEventListener('change', () => this.cb.onModeChange(this.modeSelect.value));
  }

  private wireLanding(): void {
    this.dropzone.addEventListener('click', () => this.fileInput.click());
    this.dropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') this.fileInput.click();
    });
    this.fileInput.addEventListener('change', () => {
      const f = this.fileInput.files?.[0];
      if (f) this.cb.onFile(f);
      this.fileInput.value = '';
    });
    this.demoBtn.addEventListener('click', () => this.cb.onDemo());
    document.querySelectorAll<HTMLButtonElement>('.baselines button[data-url]').forEach((btn) =>
      btn.addEventListener('click', () =>
        this.cb.onTrackUrl(btn.dataset.url!, btn.dataset.name ?? btn.textContent ?? ''),
      ),
    );

    // drag & drop anywhere, any time
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragDepth++;
      const onLanding = !this.landing.classList.contains('hidden');
      this.dragveil.classList.toggle('active', !onLanding);
      this.dropzone.classList.add('dragover');
    });
    window.addEventListener('dragleave', (e) => {
      e.preventDefault();
      if (--dragDepth <= 0) {
        dragDepth = 0;
        this.dragveil.classList.remove('active');
        this.dropzone.classList.remove('dragover');
      }
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      this.dragveil.classList.remove('active');
      this.dropzone.classList.remove('dragover');
      const f = e.dataTransfer?.files?.[0];
      if (f) this.cb.onFile(f);
    });
  }

  private wireTransport(): void {
    this.playBtn.addEventListener('click', () => this.cb.onTogglePlay());

    const seekTo = (e: PointerEvent) => {
      const r = this.seek.getBoundingClientRect();
      this.cb.onSeek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
    };
    let scrubbing = false;
    this.seek.addEventListener('pointerdown', (e) => {
      scrubbing = true;
      this.seek.setPointerCapture(e.pointerId);
      seekTo(e);
    });
    this.seek.addEventListener('pointermove', (e) => {
      if (scrubbing) seekTo(e);
    });
    this.seek.addEventListener('pointerup', () => (scrubbing = false));

    this.vol.addEventListener('input', () => this.cb.onVolume(parseFloat(this.vol.value)));

    this.fsBtn.addEventListener('click', () => void this.toggleFullscreen());

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.cb.onTogglePlay();
      } else if (e.key === 'f' || e.key === 'F') {
        void this.toggleFullscreen();
      } else if (e.key === 'd' || e.key === 'D') {
        this.devOverlay.classList.toggle('visible');
      }
    });
  }

  private async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      /* some browsers refuse outside gestures; fine */
    }
  }

  /** UI fades out after 3s of mouse stillness during playback. */
  private wireIdleHide(): void {
    const wake = () => {
      document.body.classList.remove('ui-idle');
      window.clearTimeout(this.idleTimer);
      this.idleTimer = window.setTimeout(() => {
        if (this.playing) document.body.classList.add('ui-idle');
      }, 3000);
    };
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    wake();
  }

  // ---- state pushed from the app ----

  trackLoaded(name: string): void {
    this.landing.classList.add('hidden');
    this.transport.classList.add('visible');
    this.trackName.textContent = name;
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    this.playBtn.innerHTML = playing
      ? '<svg viewBox="0 0 16 16"><rect x="3" y="2" width="3.4" height="12"/><rect x="9.6" y="2" width="3.4" height="12"/></svg>'
      : '<svg viewBox="0 0 16 16"><path d="M3 1.5 L14 8 L3 14.5 Z"/></svg>';
    if (!playing) document.body.classList.remove('ui-idle');
  }

  setProgress(current: number, total: number): void {
    const frac = total > 0 ? current / total : 0;
    this.seekFill.style.width = `${frac * 100}%`;
    this.seekKnob.style.left = `${frac * 100}%`;
    this.timeNow.textContent = formatTime(current);
    this.timeTotal.textContent = formatTime(total);
  }

  setDevText(text: string): void {
    if (this.devOverlay.classList.contains('visible')) this.devOverlay.textContent = text;
  }

  showToast(message: string, ms = 3200): void {
    this.toast.textContent = message;
    this.toast.classList.add('visible');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('visible'), ms);
  }
}

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
