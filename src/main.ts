import * as THREE from 'three';
import { AudioEngine } from './audio/engine';
import { AnalysisProducer, BAND_NAMES, emptyFrame } from './audio/analysis';
import type { AnalysisFrame } from './audio/analysis';
import type { Mode } from './modes/Mode';
import { getMode, modeRegistry } from './modes/registry';
import { UI } from './ui/ui';
import { Library } from './ui/library';
import { renderDemoPiece } from './demo/demoPiece';

// ---------------------------------------------------------------------------
// renderer / scene
// ---------------------------------------------------------------------------

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 400);

// ---------------------------------------------------------------------------
// audio: created lazily on first user gesture (autoplay policy)
// ---------------------------------------------------------------------------

let engine: AudioEngine | null = null;
let analysis: AnalysisProducer | null = null;
const idleFrame = emptyFrame();

function ensureEngine(): AudioEngine {
  if (!engine) {
    engine = new AudioEngine({
      onEnded: () => ui.setPlaying(false),
      onStateChange: (p) => ui.setPlaying(p),
    });
    analysis = new AnalysisProducer(engine);
  }
  return engine;
}

// ---------------------------------------------------------------------------
// modes
// ---------------------------------------------------------------------------

let activeMode: Mode | null = null;
let activeModeId = '';

function switchMode(id: string): void {
  const def = getMode(id);
  if (!def?.available || !def.create || id === activeModeId) return;
  activeMode?.dispose();
  activeMode = def.create();
  activeMode.init(scene, renderer, camera);
  activeMode.setQuality?.(quality);
  activeModeId = id;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const ui = new UI({
  onFile: (file) => void loadFile(file),
  onDemo: () => void loadDemo(),
  onTrackUrl: (url, name) => void loadUrl(url, name),
  onTogglePlay: () => void engine?.toggle(),
  onSeek: (f) => engine?.seek(f * (engine?.duration ?? 0)),
  onVolume: (v) => engine?.setVolume(v),
  onModeChange: switchMode,
});

async function loadFile(file: File): Promise<void> {
  const eng = ensureEngine();
  try {
    const buffer = await eng.decodeFile(file);
    eng.load(buffer);
    ui.trackLoaded(file.name.replace(/\.[a-z0-9]+$/i, ''));
    await eng.play();
  } catch {
    ui.showToast('Could not decode that file — try an MP3, FLAC, WAV or OGG.');
  }
}

const library = new Library({
  onTrackUrl: (url, name) => void loadUrl(url, name),
  onOpenFile: () => ui.openFilePicker(),
});
document.getElementById('libBtn')?.addEventListener('click', () => library.open());
document.getElementById('libBtnLanding')?.addEventListener('click', () => library.open());

async function loadUrl(url: string, name: string): Promise<void> {
  const eng = ensureEngine();
  try {
    ui.showToast('Loading…', 1500);
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.arrayBuffer();
    const buffer = await eng.ctx.decodeAudioData(data);
    eng.load(buffer);
    ui.trackLoaded(name);
    await eng.play();
  } catch {
    ui.showToast('Could not load that recording.');
  }
}

let demoBuffer: AudioBuffer | null = null;
async function loadDemo(): Promise<void> {
  const eng = ensureEngine();
  try {
    if (!demoBuffer) {
      ui.showToast('Composing the demo…', 1800);
      demoBuffer = await renderDemoPiece();
    }
    eng.load(demoBuffer);
    ui.trackLoaded('Study in D minor — demo piece');
    await eng.play();
  } catch {
    ui.showToast('Demo synthesis failed in this browser.');
  }
}

// ---------------------------------------------------------------------------
// drag-to-look (orbit limited; the viewer is inside, never orbiting)
// ---------------------------------------------------------------------------

let dragging = false;
let lookX = 0;
let lookY = 0;
let downX = 0;
let downY = 0;
let dragDist = 0;
const ndcX = (e: PointerEvent) => (e.clientX / window.innerWidth) * 2 - 1;
const ndcY = (e: PointerEvent) => -((e.clientY / window.innerHeight) * 2 - 1);
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  dragDist = 0;
  downX = e.clientX;
  downY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  activeMode?.setPointer?.(ndcX(e), ndcY(e));
  if (!dragging) return;
  dragDist = Math.max(dragDist, Math.hypot(e.clientX - downX, e.clientY - downY));
  lookX = Math.max(-1, Math.min(1, lookX - (e.movementX / window.innerWidth) * 2.2));
  lookY = Math.max(-1, Math.min(1, lookY + (e.movementY / window.innerHeight) * 2.2));
  activeMode?.setLook?.(lookX, lookY);
});
canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  if (dragDist < 8) activeMode?.tap?.(ndcX(e), ndcY(e));
});
canvas.addEventListener('dblclick', () => {
  lookX = 0;
  lookY = 0;
  activeMode?.setLook?.(0, 0);
});

// ---------------------------------------------------------------------------
// adaptive quality: degrade gracefully if frame time exceeds ~20ms sustained
// ---------------------------------------------------------------------------

// start conservatively on phones/tablets and weak machines; the watchdog
// promotes quality again if the device turns out to be fast
const isCoarse = window.matchMedia('(pointer: coarse)').matches;
const weakHints = isCoarse || (navigator.hardwareConcurrency ?? 8) <= 4;
let quality = weakHints ? 1 : 2;
if (weakHints) renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
let frameTimeAvg = 16.7;
let lastQualityChange = 0;

function watchPerformance(dtMs: number, now: number): void {
  frameTimeAvg += (dtMs - frameTimeAvg) * 0.05; // rolling window ≈ 20 frames
  if (now - lastQualityChange < 8000) return;
  if (frameTimeAvg > 20 && quality > 0) {
    quality--;
    activeMode?.setQuality?.(quality);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality === 1 ? 1.5 : 1));
    lastQualityChange = now;
  } else if (frameTimeAvg < 10.5 && quality < 2) {
    quality++;
    activeMode?.setQuality?.(quality);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality === 2 ? 2 : 1.5));
    lastQualityChange = now;
  }
}

// ---------------------------------------------------------------------------
// dev overlay (toggle with D)
// ---------------------------------------------------------------------------

function devText(f: AnalysisFrame): string {
  const rows = f.bands
    .map((b, i) => {
      const sal = f.salientBand === i ? '◀' : ' ';
      return `${BAND_NAMES[i].padEnd(10)} e=${b.energy.toFixed(2)} pan=${b.pan >= 0 ? '+' : ''}${b.pan.toFixed(2)} atk=${b.attackStrength.toFixed(2)} ${sal}`;
    })
    .join('\n');
  return (
    `${rows}\n\n` +
    `fast=${f.energyFast.toFixed(2)} slow=${f.energySlow.toFixed(2)} d/dt=${f.energyDeriv >= 0 ? '+' : ''}${f.energyDeriv.toFixed(2)}\n` +
    `centroid=${f.centroid.toFixed(2)} flux=${f.flux.toFixed(2)} onset=${f.onset.toFixed(2)}\n` +
    `width=${f.stereoWidth.toFixed(2)} salience=${f.salience.toFixed(2)} active=${f.activeBands}\n` +
    `q=${quality} ft=${frameTimeAvg.toFixed(1)}ms`
  );
}

// ---------------------------------------------------------------------------
// resize
// ---------------------------------------------------------------------------

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  activeMode?.resize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------

switchMode(modeRegistry[0].id);

let lastTime = performance.now();
function tick(now: number): void {
  requestAnimationFrame(tick);
  const dtMs = Math.min(now - lastTime, 100); // clamp tab-switch spikes
  lastTime = now;
  const dt = dtMs / 1000;

  const frame = analysis ? analysis.update(dtMs) : idleFrame;
  activeMode?.update(frame, dt);
  renderer.render(scene, camera);

  if (engine?.hasTrack) ui.setProgress(engine.currentTime, engine.duration);
  ui.setDevText(devText(frame));
  watchPerformance(dtMs, now);
}
requestAnimationFrame(tick);
