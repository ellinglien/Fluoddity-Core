# Audio-reactive Fluoddity

An audio layer for the WebGL port in `docs/`. Music drives the simulation's
physics parameters in real time — and a big enough transition in the music
generates a whole new preset, so the sim's *behaviour* changes, not just how
hard it is reacting.

Everything here is additive: with no audio running, the demo behaves exactly
as it did before.

---

## Using it

Three ways to get audio in, all in the **Audio** row of the left-hand controls:

| Source | How | Notes |
|---|---|---|
| **Share System Audio** | Turn on *Share with system audio* in the dialog | Zero setup. Chromium browsers only — the button hides elsewhere |
| **Load File** | Pick a local audio file | Decoded fully into memory, gapless loop |
| **Select input device** | Any input the OS exposes | A microphone, **or** a virtual loopback device |

**Share System Audio** is the path of least resistance: nothing to install, no
file to find, no per-app routing — it reacts to whatever the machine is
playing. The video track is dropped the moment the stream arrives, so only
audio is ever read, and ending the share from the browser's own *Stop sharing*
bar tears the driver down cleanly.

It uses **Conditional Focus** (`CaptureController.setFocusBehavior`) to stay
put. Without it the browser focuses whatever you picked, switching you away
from Fluoddity at the one moment you want to watch it react.

### The surface you pick does not matter

Chromium browsers offer three share surfaces — tab, window, entire screen — but
where a **"Share with system audio"** toggle is present it applies to the whole
system regardless of which surface is highlighted. So the surface choice buys
the user nothing here, and the request asks for `displaySurface: 'monitor'`:
the monitor pane usually has exactly one thing to click, and system audio is
its natural pairing.

Browsers differ on which surfaces carry audio at all, and this moves — Brave on
macOS offers system audio on every pane, while Chrome has historically been far
more restrictive there. The code therefore states a preference and checks the
result rather than encoding a platform matrix that would go stale.

**The toggle cannot be pre-set.** It is browser chrome and consent is
deliberately the user's; no constraint selects it. `systemAudio: 'include'` only
decides whether the option is *offered*. Leaving it off is therefore the
likeliest failure, so the thrown error names the toggle exactly.

A loopback driver (BlackHole, Soundflower) via the input-device route remains
the alternative, and the only route where a browser offers no system audio at
all.

The loopback route is the good one for playing your own music: set the system
output to BlackHole (or Soundflower), then pick that same device as the input
here. Fluoddity then reacts to anything playing on the machine — Spotify,
Ableton, a DAW — with no per-app routing.

Mic input is analysis-only; it is deliberately never connected back to the
output, which would be a feedback loop.

---

## Signal chain

```
AudioNode
  └─ AnalyserNode (fftSize 1024)
       └─ split into 3 bands ─────────► low / mid / high  (raw 0..1)
            ├─ attack-fast / release-slow smoothing   ← anti-flicker
            └─ per-band decaying ceiling              ← auto-gain
                 └─ this.bands  (normalised 0..1)
                      └─ applyTo(base, strength, routing, intensity)
                           └─ a COPY of the active preset config
```

Two properties matter for why this feels musical rather than twitchy:

**Attack fast, release slow.** A hit lands immediately; the decay back is
gradual. Raw FFT values fed straight to the physics flicker badly.

**Auto-gain per band.** Each band tracks its own slowly-decaying ceiling
(`CEILING_DECAY = 0.999`) and normalises against it, so quiet and loud
material both land in a usable 0..1 range.

### Routing — which band drives which parameter

`DEFAULT_ROUTING`, live-editable from the *customize reactions* panel:

| Physics field | Band | Amount | Combine |
|---|---|---|---|
| `global_force_mult` | low | 1.5 | multiply |
| `axial_force` | low | 0.4 | add |
| `trail_persistence` | mid | 0.15 | add, clamp 0..1 |
| `sensor_angle` | mid | 0.3 | add, bipolar around midpoint |
| `drag` | high | 0.2 | subtract |
| `strafe_power` | high | 0.1 | add, floor at 0 |

The **band** per field is user-assignable — that's a creative choice. The
**combine kind** is not: it's tied to what the parameter structurally is.
`trail_persistence` is a normalised 0..1 value, so it clamps; `sensor_angle`
swings both ways, so it's bipolar; `strafe_power` can't go negative. Letting
the panel reassign kinds would just produce broken output.

`applyTo()` writes onto a *copy* of whatever preset is active, so reactivity
plays on top of the preset's own resting values instead of replacing them.

---

## Transitions

A separate detector asks a different question from the bands. The bands track
*how loud right now*; this asks *does right now sound dramatically different
from the last several seconds*.

It runs on **raw, pre-auto-gain** energy. This is the crux: `this.bands` is
already normalised against its own ceiling precisely so quiet and loud
material read alike — which makes it useless for "is this louder than usual."
Built on `bands`, the ratio spiked on any audio within a few frames.

A transition fires when instant raw energy exceeds `TRANSITION_RATIO` (2.2) ×
a ~5.5s rolling average, and clears an absolute noise floor. When it does:

- a `boost` envelope runs fast-attack → 400ms hold → slow release, scaling
  modulation **depth** so existing motion swings further for a couple seconds
- `transitionJustFired` is set for one frame; `main.js` reads it and calls
  `generateNewPreset()`

Guards, each of which exists because of a specific observed failure:

| Constant | Value | Why |
|---|---|---|
| `TRANSITION_RATIO` | 2.2 | 1.6 and 1.15 were far too trigger-happy — ordinary beat-to-beat dynamics clear a 15–60% jump routinely |
| `TRANSITION_COOLDOWN_MS` | 6000 | A sustained loud section held the ratio above threshold for many seconds; at 1200ms it re-fired throughout an entire chorus |
| `TRANSITION_WARMUP_MS` | 2000 | The rolling average starts at 0, so the first second of any audio reads as an enormous spurious transition |

---

## Tempo

Beat-onset detection on raw bass feeds an inter-onset-interval histogram for a
live BPM estimate. It stays `null` until confident — at least 6 onsets inside
an 8s window, range 60–200 BPM, smoothed rather than snapped.

Two things use it:

- **adjust speed** scales the physics speed slider by `bpm / 120`
- **quantize to bar** makes a detected transition wait to *commit* until the
  next bar-aligned onset (every 4th beat) instead of firing the instant it's
  detected, with a 2.5s safety valve

`beatDelayMs` pushes that commit later by a fixed offset. It exists for **live
input specifically**, tuned by ear, to compensate for onset-detection lag plus
output/speaker latency so the reaction lands on the beat as actually heard.

> File playback has a better fix available for the same problem — true
> lookahead, reading ahead in the already-decoded buffer instead of delaying
> after the fact. Not implemented.

---

## Shader changes

**`cam_brush.vert` — `audio_hue_shift`**

A continuously-advancing 0..1 hue offset added to every cohort's hue, so the
whole palette drifts together with the music. Added to all cohorts equally,
which preserves the relative hue differences that keep cohorts visually
distinguishable. Backed by the *Hue Shift* slider.

**`entity_update.frag` — `cohort_fences` + aspect-correct grid**

`grid_dims()` sizes the Grid starting layout to the canvas's real aspect
ratio: columns proportional to `sqrt(cohorts × aspect)`, so a wide window gets
more columns than rows instead of stretching cells into thin strips.
`cohort_fences` adds a soft leash holding each entity near its home cell.
Grid-mode only — it's the only layout with a stable per-cohort cell to
derive a radius from.

---

## Glow vs. routing

The *Glow* slider drives overall brightness from `overallEnergy` — a
deliberately simple, global reaction. It reads clearly as audio-driven at a
glance, where the per-parameter routing above is easy to miss: its effect is a
diffuse shift in an emergent flow pattern.

---

## Files

| File | Change |
|---|---|
| `docs/audio.js` | **New**, ~700 lines — sources, driver, routing |
| `docs/main.js` | Frame-loop hookup, preset generation, mix panel, debug panel |
| `docs/index.html` | Audio controls, mix panel, sliders |
| `docs/shaders/cam_brush.vert` | `audio_hue_shift` uniform |
| `docs/shaders/entity_update.frag` | `cohort_fences`, aspect-correct grid |
| `docs/input.js` | Pan/zoom removed — the view is fixed to the window |
| `docs/state.js`, `ui.js`, `particle_system.js`, `gl_utils.js` | Supporting wiring |

`window.__audioDriver` is exposed in the console for poking at live band
values while tuning.

---

## Credit

Fluoddity is by **aphid91** — <https://github.com/aphid91/Fluoddity>.
This is an audio layer on the WebGL port in
[Fluoddity-Core](https://github.com/aphid91/Fluoddity-Core); the simulation,
the shaders and the physics are all upstream work.
