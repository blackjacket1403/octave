# Inside the Orchestra

An immersive visualization of classical music. Drop in any recording (MP3 / FLAC / WAV / OGG)
— or play the bundled demo piece — and stand at the conductor's podium of a dark concert hall
where every voice in the music is a body of living light.

This is not an equalizer. There are no bars, waveforms, or spectrum rings. The five musical
registers (bass, tenor, alto, soprano, brilliance) become five breathing swarms of light,
arranged like orchestra seating:

- **Where a sound comes from** — stereo pan places its body left or right on the arc.
- **How high it sings** — register sets altitude; bass glows near the floor, brilliance overhead.
- **How loud it is** — loudness brings a body toward you; a crescendo is light approaching.
- **What to listen to** — a salience tracker finds the melodic foreground; that body
  intensifies, tightens, trails light, and the camera leans gently toward it.
- **Attacks** — onsets ripple outward as pulses of light.
- **Texture and memory** — busy passages fill the hall with haze and motes; climaxes warm
  the ambient tone and leave a slow-fading afterglow on the floor.

Everything is decoded and analyzed locally with the Web Audio API. Nothing is uploaded.

## Running

```sh
npm install
npm run dev      # local dev server
npm run build    # type-check + production build to dist/
```

Keyboard: `Space` play/pause · `F` fullscreen · `D` analysis debug overlay · drag to look around.

## Architecture

```
src/
  audio/      AudioContext graph, AnalysisFrame producer, envelope smoothing
  modes/      Mode interface + registry; modes consume AnalysisFrame only
    luminousHall/   Mode 1 — the Luminous Hall (light bodies, ripples, atmosphere, camera rig)
  ui/         landing, transport, mode picker, auto-hide
  demo/       offline-rendered ~45s demo piece (oscillators; no copyrighted audio)
```

Future modes are stubbed in the registry: Ink and Current, Growing Garden, Celestial Mechanics.
