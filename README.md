# Inside the Orchestra

An immersive visualization of classical music. Drop in any recording (MP3 / FLAC / WAV / OGG)
— or play the bundled demo piece — and stand at the conductor's podium of a dark concert hall
where every voice in the music is a body of living light.

This is not an equalizer. There are no bars, waveforms, or spectrum rings. The five musical
registers (bass, tenor, alto, soprano, brilliance) become five aurora strands — continuous
ribbons of light undulating like slow bow strokes — arranged like orchestra seating:

- **Where a sound comes from** — stereo pan places its body left or right on the arc.
- **How high it sings** — register sets altitude; bass glows near the floor, brilliance overhead.
- **How loud it is** — loudness brings a body toward you; a crescendo is light approaching.
- **What to listen to** — a salience tracker finds the melodic foreground; that body
  intensifies, tightens, trails light, and the camera leans gently toward it.
- **Attacks** — onsets travel outward along the strand as pulses of light.
- **Texture and memory** — busy passages fill the hall with haze and motes; climaxes warm
  the ambient tone and leave a slow-fading afterglow on the floor.

Everything is decoded and analyzed locally with the Web Audio API. Nothing is uploaded.

Baseline recordings bundled in `public/audio/`: Vivaldi, *The Four Seasons* — Spring I and
Winter I, performed by John Harrison with the Wichita State University Chamber Players,
licensed CC BY-SA (via classicals.de). The third baseline is a synthesized 45-second study
rendered with oscillators at runtime.

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

Five modes share the one analysis engine, selectable from the transport bar:

1. **The Voyage** (default) — fly forward through deep space; the voices are silk ribbons
   weaving and slaloming past star systems, each star tuned to a voice and its planets
   revolving faster the louder that voice plays. Interactive: ribbons lean toward your
   pointer, and a click/tap detonates a small supernova they scatter from.
2. **The Luminous Hall** — first-person at the podium; each voice is a twisting aurora strand
   of light on the orchestra arc. Crescendos approach; the melody sharpens and sheds sparks.
3. **Ink and Current** — voices as pigment currents in water on paper; counterpoint braids,
   onsets drop blooming ink, swells flood the sheet.
4. **The Growing Garden** — phrases grow vines, leaves, and golden blooms on parchment into a
   persistent canvas; the finished piece is a grown landscape of the work's structure.
5. **Celestial Mechanics** — a living spiral galaxy: the disk's rotation, glitter, and core
   fire follow the music while the voices swoop around the burning centre leaving trails;
   fast figuration births showers of new stars.

**Changing music:** the “Music” button in the transport (or “Search the archive…” on the
landing page) opens a library that searches the Internet Archive's public-domain audio
collections (no key, fully client-side) and streams any MP3 track it finds — plus the
bundled Vivaldi baselines and a local-file picker.
