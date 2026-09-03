/**
 * audio.js — audio-reactive driver for Fluoddity-Core (docs/ WebGL port).
 *
 * Wired into main.js's frame() loop and the "Audio" controls in
 * index.html -- search main.js for "audioDriver" to see the hookup.
 *
 * Design:
 *   1. sourceFromFile / sourceFromInputDevice / sourceFromDisplayMedia —
 *      straightforward ways to get a live AudioNode: a file picked by the
 *      user, a specific input device (mic or a virtual loopback device --
 *      see listAudioInputDevices), or (Chrome only) shared tab/system audio.
 *   2. AudioReactiveDriver — reads an AnalyserNode once per frame, splits
 *      it into low/mid/high bands, and smooths each with attack-fast/
 *      release-slow ballistics (the actual anti-flicker step) plus a
 *      slowly-decaying per-band ceiling for auto-gain (so quiet and loud
 *      source material both produce a usable 0..1 range).
 *   3. AudioReactiveDriver ALSO detects dramatic transitions (a drop, a
 *      quiet-to-loud section change -- see _updateTransitionBoost) and
 *      drives a separate `boost` envelope through a fast-attack/slow-
 *      release curve: quick to snap in, fluid to ease back out. It also
 *      sets `transitionJustFired` for one frame per detected transition --
 *      main.js reads this to generate a brand new preset entirely (see
 *      generateNewPreset) alongside the parameter surge, so a big
 *      transition changes the sim's actual behavior, not just how hard the
 *      current one is reacting.
 *   4. applyTo(base, strength, routing, transitionIntensity) — writes
 *      modulated values onto a *copy* of whatever preset config is active,
 *      so audio reactivity plays on top of the preset's own resting values
 *      instead of replacing them. `boost` scales the modulation DEPTH on
 *      top of `strength`, so a transition makes the existing motion swing
 *      further for a couple seconds rather than jumping to a separate
 *      look. `routing` (see DEFAULT_ROUTING/FIELD_KINDS below) is which
 *      band drives which field, and how strongly -- the live-editable part
 *      backing main.js's "customize reactions" mix panel. Field names are
 *      lowercase_snake_case to match gl_utils.js's loadConfig() -- the
 *      real shape of the live config object.
 *   5. overallEnergy (getter) and transitionRatio (settable property) --
 *      overallEnergy backs main.js's brightness "Glow" slider, a
 *      deliberately simple/global reaction (the whole picture pulses with
 *      the music) that reads more clearly as audio-driven than the
 *      per-param routing above, which is easy to miss at a glance since
 *      its effect is a diffuse shift in an emergent flow pattern.
 *      transitionRatio replaces the module-level TRANSITION_RATIO constant
 *      when the caller wants transition SENSITIVITY user-adjustable (not
 *      just the response's intensity, which `transitionIntensity` above
 *      already covers) -- see main.js's own "Sensitivity" slider.
 *   6. `bpm` (getter-like public property, null until confident) -- beat-
 *      onset detection off raw bass energy, feeding an inter-onset-
 *      interval histogram (see _updateBpm/_recomputeBpm) for a live tempo
 *      estimate. main.js's own "adjust speed" toggle scales the physics
 *      speed slider's effective value by bpm/120 when this is non-null.
 *      `quantizeToBar` (settable, default true) makes a detected
 *      transition wait to COMMIT until the next bar-aligned onset (every
 *      4th beat) instead of firing the instant it's detected -- see
 *      _updateTransitionBoost/_commitTransition/_updateBpm. `beatDelayMs`
 *      (settable, default 0) pushes that commit later by a fixed offset,
 *      tunable by ear against LIVE input specifically -- compensates for
 *      onset-detection lag and output/speaker latency, so the reaction
 *      lands on the beat as actually heard. (File playback has a real,
 *      better fix for the same problem -- true lookahead, reading ahead
 *      in the already-fully-decoded buffer instead of delaying after the
 *      fact -- not implemented here.)
 */

// ─── 1. Audio source helpers ────────────────────────────────────────────────

/**
 * File picked by the user, decoded fully into memory and looped with an
 * AudioBufferSourceNode -- NOT an <audio loop> element. <audio>'s native
 * looping re-seeks/re-buffers at the loop point, which audibly stutters
 * (confirmed live: a ~1s gap right at the loop boundary, during which the
 * analyser reads near-silence too, so the visual effect visibly drops out
 * in sync with the audio glitch). AudioBufferSourceNode loops are
 * sample-accurate/gapless since it's just replaying an already-decoded
 * PCM buffer in memory -- the standard fix for gapless looping in the Web
 * Audio API. Trade-off: the whole file decodes into memory upfront (fine
 * for a demo; would matter for a very long track) and the returned node
 * is one-shot -- call start() once, and load a new file to play a
 * different one rather than trying to restart the same node.
 *
 * @param {AudioContext} audioContext
 * @param {File} file
 * @returns {Promise<{ node: AudioBufferSourceNode, start: () => void }>}
 */
export async function sourceFromFile(audioContext, file) {
  const arrayBuffer = await file.arrayBuffer()
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
  const node = audioContext.createBufferSource()
  node.buffer = audioBuffer
  node.loop = true
  node.connect(audioContext.destination)
  return { node, start: () => node.start() }
}

/**
 * Live input from a specific device, selected by deviceId -- covers both
 * a plain microphone AND any virtual loopback device already installed
 * (BlackHole, Soundflower, etc.): set your Mac's system OUTPUT to the
 * loopback device, then pick that same device here as the INPUT, and
 * Fluoddity reacts to whatever's actually playing anywhere on the machine
 * (Spotify, Ableton, a DAW) -- no Chrome tab-share needed, and no
 * per-app routing, since it's your whole system output. See
 * listAudioInputDevices() below for populating a real device list.
 * Requires a user gesture to resolve the getUserMedia permission prompt.
 *
 * @param {AudioContext} audioContext
 * @param {string} deviceId
 * @returns {Promise<AudioNode>}
 */
export async function sourceFromInputDevice(audioContext, deviceId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: deviceId } }
  })
  return audioContext.createMediaStreamSource(stream)
  // Deliberately NOT connected to destination -- routing input straight
  // back out is a feedback-loop footgun for a real mic, and redundant for
  // a loopback device (the OS is already playing that audio on its own).
  // Analysis only.
}

/**
 * Lists available audio input devices. Labels (e.g. "BlackHole 2ch",
 * "MacBook Pro Microphone") are only populated once mic permission has
 * been granted at least once in this browser for this page -- before
 * that, every device shows a blank label with a real deviceId. Callers
 * should request+immediately-release a generic getUserMedia({audio:true})
 * stream first (see main.js's populateAudioInputDevices) if labels matter,
 * which they do for a picker UI -- an unlabeled dropdown of opaque ids is
 * not something a person can choose from.
 *
 * @returns {Promise<MediaDeviceInfo[]>}
 */
export async function listAudioInputDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((d) => d.kind === 'audioinput')
}

/**
 * Shared tab/window/system audio via the screen-share picker. Chrome-only;
 * Firefox/Safari don't support capturing audio through getDisplayMedia.
 * Good for "make Fluoddity react to whatever's playing in Spotify/YouTube."
 *
 * @param {AudioContext} audioContext
 * @returns {Promise<AudioNode>}
 */
export async function sourceFromDisplayMedia(audioContext) {
  const options = {
    // Open the picker on the TAB list. Of the three surfaces Chrome offers,
    // only a tab carries audio on every platform: a window/app surface has no
    // audio at all, anywhere, and "entire screen" only carries system audio on
    // Windows/ChromeOS -- on macOS it is silent. Landing the user on the one
    // pane that can actually work saves a silent failure.
    video: { displaySurface: 'browser' },
    audio: true,
    // Nothing to gain from sharing Fluoddity with itself.
    selfBrowserSurface: 'exclude',
    // Where system audio IS available (Windows/ChromeOS), offer it.
    systemAudio: 'include',
    surfaceSwitching: 'include'
  }

  // Chrome focuses the captured surface by default, so picking a tab or window
  // in the share dialog switches you straight to it -- exactly the wrong moment
  // to be pulled away from Fluoddity, since the whole point is to watch it react
  // to that audio. Conditional Focus opts out of the focus change; the picker
  // still works normally, you just stay here. Chrome 109+; harmless elsewhere,
  // since we only build the controller when the constructor exists.
  let controller = null
  if (typeof CaptureController !== 'undefined') {
    controller = new CaptureController()
    options.controller = controller
  }

  const stream = await navigator.mediaDevices.getDisplayMedia(options)

  // Must be called before the browser makes its focus decision, which is why
  // this sits immediately after the await with nothing between. Throws if that
  // window has already passed -- not worth failing the capture over.
  if (controller) {
    try { controller.setFocusBehavior('no-focus-change') } catch (e) { /* too late */ }
  }

  // The audio checkbox cannot be pre-ticked by a page -- it is browser chrome,
  // deliberately user-controlled -- so forgetting it is the single most likely
  // way this fails. Say exactly which box, and note the surfaces that can never
  // work rather than leaving the user to retry the same silent choice.
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error(
      'No audio in that share. Pick a tab and tick "Also share tab audio" -- ' +
      'a window or app share carries no audio at all, and "entire screen" ' +
      'only carries audio on Windows.'
    )
  }
  // Video track isn't needed once we have the audio node -- drop it so the
  // browser's screen-share indicator doesn't stay lit for no reason.
  stream.getVideoTracks().forEach((t) => t.stop())
  return audioContext.createMediaStreamSource(stream)
}

// ─── 2. Band splitting + smoothing ──────────────────────────────────────────

// Roughly log-spaced band edges (Hz) across the audible range -- not
// perceptually exact (a real Bark/Mel scale would be), but plenty for
// driving a handful of physics sliders distinctly.
const BAND_EDGES = {
  low: { from: 20, to: 250 }, // kick, bass
  mid: { from: 250, to: 2000 }, // vocals, leads, snare body
  high: { from: 2000, to: 8000 } // hats, cymbals, sparkle
}

// Per-frame lerp factors (~60fps). Fast attack (snap up), slow release
// (decay down) -- same ballistics as an analog VU meter. This one thing
// matters more than anything else here: raw FFT data updates ~60x/sec and
// is spiky, so feeding it straight into a physics param reads as flicker,
// not motion. 0.65 (not higher) -- pushed up from an initial 0.5 per direct
// feedback that the reaction felt laggy; higher still starts to reintroduce
// flicker on percussive material, this is close to the ceiling.
const ATTACK = 0.65
const RELEASE = 0.06

// How fast the auto-gain ceiling decays back down once the source gets
// quieter -- slow enough that it doesn't visibly "breathe" on every beat,
// fast enough that the viz recalibrates within a few seconds of a section
// change (loud chorus -> quiet verse).
const CEILING_DECAY = 0.999
const CEILING_FLOOR = 0.05 // avoids dividing by ~0 during silence

// ─── Transition detection ───────────────────────────────────────────────────
// Separate from the per-band attack/release above -- that system tracks
// "how loud right now," this one asks a different question: "does right
// now sound dramatically different from the last several seconds." A big
// build-into-drop or a quiet-to-loud section change should read as a
// distinct EVENT, not just a bigger version of normal reactivity.

// Built on RAW (pre-auto-gain) overall energy, deliberately NOT this.bands
// -- this.bands is already normalized against its own per-band ceiling
// specifically so quiet and loud material read similarly, which makes it
// useless as a "is this louder than usual" signal (confirmed live: built
// on this.bands, the ratio spiked to >1 almost immediately on ANY audio,
// because bands snaps to ~its own normalized resting value within a few
// frames regardless of the source's real loudness, before the rolling
// average has any data to compare against). Raw energy hasn't been
// through that normalization, so a genuine loudness jump still looks like
// one relative to its own recent raw average.
const LONG_AVG_RATE = 0.003 // ~5.5s time constant at 60fps
const TRANSITION_RATIO = 2.2 // instant raw energy must exceed 2.2x the rolling average -- was 1.6, then briefly 1.15 per direct request; both read as WAY too trigger-happy on real music ("too many transitions... very infrequent" per direct feedback), since normal beat-to-beat dynamics alone routinely swing well past a 15-60% jump. 2.2x is a real, rare event.
const TRANSITION_ABS_MIN = 0.06 // ...and be more than near-silence noise (raw scale, not the 0..1-normalized band scale)
// Was 1200ms -- a sustained loud section (not just a single hit) kept the
// ratio above threshold for many seconds, so the OLD cooldown alone let it
// re-fire every ~1.2s the whole time a chorus/drop lasted, which is what
// actually produced "too many transitions" (each one now also generates a
// whole new preset -- see main.js's generateNewPreset -- so this reads as
// constant jarring switching, not rare drama). 6000ms puts a hard floor under how
// often ANY transition can happen, independent of Sensitivity.
const TRANSITION_COOLDOWN_MS = 6000
// Ignore the detector entirely for this long after construction -- the
// rolling average starts at 0 and needs real samples before "N times the
// average" means anything; without this, the very first second of any
// audio reads as an enormous, spurious "transition" (confirmed live).
const TRANSITION_WARMUP_MS = 2000

// The "boost" envelope's own ballistics -- distinct from, and layered on
// top of, the per-band ATTACK/RELEASE above. Fast (not instant) attack so
// a transition still reads as fluid motion rather than a hard cut; a
// brief hold at the peak so it registers as a deliberate hit, not a blip;
// then a slow release back to normal reactivity.
const BOOST_ATTACK = 0.35 // ~8 frames (~130ms) to reach ~95% of peak
const BOOST_HOLD_MS = 400
const BOOST_RELEASE = 0.03 // ~1.5-2s fluid fade back to baseline
// How much extra modulation depth full boost adds, as a multiplier on top
// of the normal (boost=0) depth -- 2.0 means "3x the usual swing" at peak.
const BOOST_EXTRA = 2.0

// ─── BPM detection ──────────────────────────────────────────────────────────
// Built on RAW low-band energy (kick/bass), not this.bands.low -- same
// reasoning as transition detection: the heavily-smoothed, auto-gain-
// normalized band exists to look musically pleasant, not to preserve
// precise onset TIMING, and BPM detection lives or dies on timing.
//
// Approach: mark an "onset" whenever raw bass energy spikes well above its
// own short-term local average (a lightweight, separate-from-auto-gain
// baseline -- see ONSET_LOCAL_AVG_RATE), then keep a rolling window of
// recent onset timestamps and build a histogram of the BPM each PAIR of
// onsets implies (not just consecutive pairs -- catches the true period
// even across an occasionally-missed beat), folding every candidate into
// [BPM_MIN, BPM_MAX] by doubling/halving so half-time and double-time
// candidates reinforce the same bucket instead of splitting the vote. The
// bucket with the most votes wins. This is the same class of technique
// classic realtime JS beat-detectors use -- not concert-grade, but solid
// for music with a real beat.
const ONSET_LOCAL_AVG_RATE = 0.1 // faster-moving than the auto-gain ceiling -- a genuinely LOCAL baseline
const ONSET_THRESHOLD_RATIO = 1.4 // raw bass must exceed 1.4x its own recent local average
const ONSET_ABS_MIN = 0.05 // ...and clear this floor, so near-silence noise can't trigger onsets
const ONSET_MIN_INTERVAL_MS = 200 // refractory period between onsets -- also caps detection at 300 BPM
const BPM_MIN = 60
const BPM_MAX = 200
const BPM_HISTORY_MS = 8000 // only onsets from the last ~8s feed the histogram
const BPM_MIN_ONSETS = 6 // need at least this many recent onsets before reporting ANY bpm
const BPM_SMOOTHING = 0.3 // per-recompute lerp toward the new best bucket, not a snap

// Quantizing a transition COMMIT to a bar boundary means every 4th onset
// (assuming 4/4 -- there's no true downbeat/"which beat is beat 1"
// detection here, just a count of raw onsets, so this is "every 4 beats,"
// not necessarily THE bar's actual start) rather than a fixed wall-clock
// bar length -- ties the commit to a REAL detected beat instead of an
// extrapolated future timestamp, which stays correct even if the tempo
// isn't perfectly steady. Only engages once a confident bpm exists.
const PENDING_TRANSITION_MAX_WAIT_MS = 2500 // safety valve -- see _updateTransitionBoost

export class AudioReactiveDriver {
  /**
   * @param {AudioContext} audioContext
   * @param {AudioNode} sourceNode - already connected into audioContext's graph
   * @param {number} fftSize - must be a power of 2. 1024 (not the more
   *   common 2048) is a deliberate latency/resolution trade: the analyser
   *   can't report on a chunk of audio until it's buffered `fftSize`
   *   samples, so at 44.1kHz, 2048 means a fundamental ~46ms delay before
   *   any reading reflects a given moment of sound, vs. ~23ms at 1024 --
   *   real, felt latency per direct feedback. Frequency RESOLUTION drops
   *   too, but that cost is basically free here: this only ever averages
   *   broad band ranges (see BAND_EDGES), never reads individual bins, so
   *   the coarser resolution doesn't show up in the output.
   */
  constructor(audioContext, sourceNode, fftSize = 1024) {
    this.analyser = audioContext.createAnalyser()
    this.analyser.fftSize = fftSize
    // We do our own attack/release below (see update()) -- the built-in
    // smoothingTimeConstant is a single symmetric exponential average and
    // can't do fast-attack/slow-release, so it's turned off here.
    this.analyser.smoothingTimeConstant = 0
    sourceNode.connect(this.analyser)

    this._freqData = new Uint8Array(this.analyser.frequencyBinCount)
    this._binRanges = binRangesForBands(this.analyser.frequencyBinCount, audioContext.sampleRate)

    // Smoothed 0..1 band energies, read by applyTo() below.
    this.bands = { low: 0, mid: 0, high: 0 }
    this._ceiling = { low: CEILING_FLOOR, mid: CEILING_FLOOR, high: CEILING_FLOOR }

    // Transition detection -- see the constants above for the reasoning.
    // boost and transitionJustFired are public values applyTo()/main.js
    // read; transitionRatio is public and WRITABLE (main.js's own
    // "Sensitivity" slider sets it every frame) -- starts equal to the
    // TRANSITION_RATIO constant, which stays the fallback/reference value
    // but is no longer read directly once an instance exists. The rest are
    // private bookkeeping for update()/_updateTransitionBoost() below.
    this.boost = 0
    this.transitionJustFired = false
    this.transitionRatio = TRANSITION_RATIO
    // Public and WRITABLE (main.js's own "quantize to bar" checkbox) --
    // whether a DETECTED transition commits immediately or waits for the
    // next bar-aligned onset (see _updateBpm/_commitTransition). Only
    // actually engages once `bpm` is non-null; falls back to immediate
    // commit otherwise, since there's no rhythmic grid to snap to yet.
    this.quantizeToBar = true
    this._rawLongAvg = 0
    this._boostTarget = 0
    this._lastTransitionAt = -Infinity
    // Separate from _lastTransitionAt on purpose -- that anchors the
    // cooldown-before-a-NEW-detection to the moment of DETECTION;
    // _committedAt anchors the hold-then-release ballistics to the moment
    // the boost envelope actually started, which with quantization can be
    // up to a bar later. Conflating the two meant the boost was already
    // past its hold window and releasing again within one frame of
    // finally committing, on any transition delayed by quantization.
    this._committedAt = -Infinity
    this._pendingTransition = false
    this._pendingTransitionSince = 0
    // Public and WRITABLE (main.js's own "Beat Delay" slider, ms) --
    // shifts a bar-quantized commit LATER by this much, tunable by ear to
    // compensate for onset-detection lag and speaker/output latency, so
    // the visible reaction lands exactly on the beat someone actually
    // hears rather than the moment the analyser detected it. Only
    // meaningful for live input (a real, unpredictable stream) -- with
    // file playback (a fully decoded, known buffer) there's a real, better
    // fix for the same underlying problem: true lookahead prediction
    // (reading ahead in the buffer instead of delaying after the fact) --
    // not implemented here, this is the live-input-only compensating
    // knob. Only ever consulted via _scheduledCommitAt below, never read
    // directly elsewhere.
    this.beatDelayMs = 0
    this._scheduledCommitAt = null
    this._startedAt = performance.now()

    // BPM detection -- see the constants above. `bpm` is the public value
    // (null until BPM_MIN_ONSETS confident onsets have been seen), the
    // rest is private bookkeeping for _updateBpm()/_recomputeBpm() below.
    this.bpm = null
    this._onsetLocalAvg = 0
    this._lastOnsetAt = -Infinity
    this._onsetTimestamps = []
    this._onsetCount = 0
  }

  /**
   * Mean of the three smoothed bands, 0..1 -- a single overall "how loud/
   * energetic right now" number for reactions that should stay a global,
   * single-channel cue (e.g. main.js's brightness glow) rather than the
   * per-band routing applyTo() does. Deliberately simple/legible: a picture
   * that just glows brighter with the music reads as "reacting to sound"
   * far more directly than a diffuse shift in an emergent flow pattern
   * does, per direct feedback that the existing per-param modulation was
   * too hard to attribute to the audio at a glance.
   */
  get overallEnergy() {
    return (this.bands.low + this.bands.mid + this.bands.high) / 3
  }

  /** Call once per animation frame, before applyTo(). */
  update() {
    this.analyser.getByteFrequencyData(this._freqData)

    let rawSum = 0
    let rawLow = 0
    for (const band of /** @type {const} */ (['low', 'mid', 'high'])) {
      const raw = averageEnergy(this._freqData, this._binRanges[band]) // 0..1
      rawSum += raw
      if (band === 'low') rawLow = raw

      // Auto-gain: normalize against a slowly-decaying running ceiling so
      // quiet and loud material both land in a usable range, instead of
      // one fixed threshold working for neither.
      this._ceiling[band] = Math.max(raw, this._ceiling[band] * CEILING_DECAY)
      const normalized = Math.min(1, raw / this._ceiling[band])

      const rate = normalized > this.bands[band] ? ATTACK : RELEASE
      this.bands[band] += (normalized - this.bands[band]) * rate
    }

    this._updateTransitionBoost(rawSum / 3)
    this._updateBpm(rawLow)
  }

  /**
   * Detects a dramatic change (a drop, a quiet-to-loud section change) by
   * comparing current RAW overall energy (see the constants above for why
   * raw, not this.bands) against a slow rolling average of itself, then
   * drives `this.boost` through a fast-attack/hold/slow-release envelope.
   * applyTo() reads `this.boost` to scale how far each param swings from
   * its base value, so a transition makes the existing modulation surge,
   * rather than jumping to some separate "transition state."
   *
   * Also sets `this.transitionJustFired` -- true for exactly the one frame
   * a transition COMMITS (an edge, not a level, unlike `boost` itself
   * which stays elevated for its whole hold+release). main.js reads this
   * to generate a brand new preset (see main.js's generateNewPreset)
   * alongside the parameter surge, so a dramatic transition changes the
   * sim's actual BEHAVIOR, not just how hard the existing behavior reacts.
   *
   * DETECTION (the ratio/threshold check below) and COMMIT (actually
   * setting boostTarget/transitionJustFired -- see _commitTransition) are
   * separate moments when `quantizeToBar` is on and a confident `bpm`
   * exists: detection just marks a transition PENDING; _updateBpm's own
   * onset handling is what actually commits it, at the next onset that
   * lands on a bar boundary (every 4th onset). Without a confident bpm,
   * commit happens immediately, same as before bar-quantization existed.
   *
   * @param {number} rawOverall - mean raw (pre-normalization) band energy
   *   for this frame, from update() above.
   */
  _updateTransitionBoost(rawOverall) {
    this._rawLongAvg += (rawOverall - this._rawLongAvg) * LONG_AVG_RATE

    const now = performance.now()
    const warmedUp = now - this._startedAt > TRANSITION_WARMUP_MS
    const ratio = rawOverall / Math.max(this._rawLongAvg, 0.02)
    this.transitionJustFired = false

    const detected =
      warmedUp &&
      ratio > this.transitionRatio &&
      rawOverall > TRANSITION_ABS_MIN &&
      now - this._lastTransitionAt > TRANSITION_COOLDOWN_MS

    if (detected) {
      // Anchored here (detection), not at commit -- this is what paces
      // how often a NEW transition can be detected at all, independent of
      // how long any one of them then waits to actually commit.
      this._lastTransitionAt = now
      if (this.quantizeToBar && this.bpm !== null) {
        this._pendingTransition = true
        this._pendingTransitionSince = now
      } else {
        this._commitTransition()
      }
    }

    // A bar boundary was reached (see _updateBpm) and scheduled a commit
    // beatDelayMs in the future -- fire it once that time actually
    // arrives. Checked every frame here (not just at the onset that set
    // it) since the delay generally spans multiple frames.
    if (this._scheduledCommitAt !== null && now >= this._scheduledCommitAt) {
      this._commitTransition()
    }

    // Safety valve: a transition still waiting for a bar boundary that
    // never arrived (bpm confidence lost, or quantizeToBar toggled off,
    // mid-wait) fires late rather than being silently swallowed forever.
    if (this._pendingTransition && now - this._pendingTransitionSince > PENDING_TRANSITION_MAX_WAIT_MS) {
      this._commitTransition()
    }

    if (!this.transitionJustFired && now - this._committedAt > BOOST_HOLD_MS) {
      this._boostTarget = 0
    }

    const rate = this._boostTarget > this.boost ? BOOST_ATTACK : BOOST_RELEASE
    this.boost += (this._boostTarget - this.boost) * rate
  }

  /**
   * Actually applies a pending (or immediate) transition -- called from
   * _updateTransitionBoost above, either synchronously (no quantization,
   * or no confident bpm yet), once a scheduled beatDelayMs wait elapses,
   * or from the safety valve.
   */
  _commitTransition() {
    this._boostTarget = 1
    this.transitionJustFired = true
    this._pendingTransition = false
    this._scheduledCommitAt = null
    this._committedAt = performance.now()
  }

  /**
   * Onset detection for BPM tracking -- see the BPM constants above for
   * the full approach. Marks an onset whenever raw bass energy spikes over
   * its own short-term local average, subject to a refractory period and
   * an absolute floor, then feeds the onset timestamp into the rolling
   * window _recomputeBpm() analyzes.
   *
   * ALSO where a pending (bar-quantized) transition gets SCHEDULED -- see
   * _updateTransitionBoost's own doc comment -- every 4th onset counts as
   * a bar boundary (no true downbeat detection, just a beat count assuming
   * 4/4). Scheduled rather than committed immediately here so beatDelayMs
   * (main.js's "Beat Delay" slider) can push the actual commit later,
   * tunable by ear to compensate for onset-detection lag and speaker/
   * output latency on live input, so the reaction lands on the beat as
   * actually heard rather than the moment it was analytically detected.
   *
   * @param {number} rawLow - this frame's raw (pre-normalization) low-band
   *   energy, from update() above.
   */
  _updateBpm(rawLow) {
    this._onsetLocalAvg += (rawLow - this._onsetLocalAvg) * ONSET_LOCAL_AVG_RATE

    const now = performance.now()
    const isOnset =
      rawLow > this._onsetLocalAvg * ONSET_THRESHOLD_RATIO &&
      rawLow > ONSET_ABS_MIN &&
      now - this._lastOnsetAt > ONSET_MIN_INTERVAL_MS
    if (!isOnset) return

    this._lastOnsetAt = now
    this._onsetTimestamps.push(now)
    const cutoff = now - BPM_HISTORY_MS
    while (this._onsetTimestamps.length > 0 && this._onsetTimestamps[0] < cutoff) {
      this._onsetTimestamps.shift()
    }
    this._recomputeBpm()

    this._onsetCount++
    if (this._pendingTransition && this._onsetCount % 4 === 0 && this._scheduledCommitAt === null) {
      this._scheduledCommitAt = now + this.beatDelayMs
    }
  }

  /**
   * Builds a BPM histogram from every PAIR of recent onsets (not just
   * consecutive ones -- an occasionally-missed beat still leaves plenty of
   * pairs implying the true period), folds each candidate into
   * [BPM_MIN, BPM_MAX] by doubling/halving (so half-time/double-time
   * candidates reinforce the same bucket rather than splitting the vote),
   * and takes the most-voted bucket. Onset count stays small enough
   * (ONSET_MIN_INTERVAL_MS caps it at 5/sec, times an 8s window = at most
   * ~40) that the O(n^2) pairwise comparison is trivial, and this only
   * runs once per NEW onset, not every frame.
   */
  _recomputeBpm() {
    const times = this._onsetTimestamps
    if (times.length < BPM_MIN_ONSETS) {
      this.bpm = null
      return
    }

    const votes = new Map() // rounded bpm -> vote count
    for (let i = 0; i < times.length; i++) {
      for (let j = i + 1; j < times.length; j++) {
        const intervalMs = times[j] - times[i]
        if (intervalMs <= 0) continue
        let candidate = 60000 / intervalMs
        while (candidate < BPM_MIN) candidate *= 2
        while (candidate > BPM_MAX) candidate /= 2
        const bucket = Math.round(candidate)
        votes.set(bucket, (votes.get(bucket) || 0) + 1)
      }
    }

    let bestBucket = null
    let bestVotes = 0
    for (const [bucket, count] of votes) {
      if (count > bestVotes) {
        bestVotes = count
        bestBucket = bucket
      }
    }
    if (bestBucket === null) return

    // Smoothed toward the new estimate rather than snapped, so the
    // reported/used BPM doesn't jump around between adjacent candidate
    // buckets onset-to-onset.
    this.bpm = this.bpm === null ? bestBucket : this.bpm + (bestBucket - this.bpm) * BPM_SMOOTHING
  }

  /**
   * Returns a new config object with physics fields modulated around
   * `base`'s own values (the active preset's resting state) by the current
   * smoothed band energies, per `routing` -- see DEFAULT_ROUTING and
   * FIELD_KINDS below for what's fixed vs. customizable. Doesn't mutate
   * `base`.
   *
   * Field names are lowercase_snake_case to match gl_utils.js's loadConfig()
   * -- the real shape of the live config object the shader actually reads.
   * (An earlier version of this file used UPPERCASE names copied from
   * main.js's unrelated, unused-in-Fluoddity-Core PARAM_NAMES sweep/jitter
   * list -- that meant every one of these writes landed on a key nothing
   * ever read, so the audio reactivity silently did nothing at all. Caught
   * by a debug panel throwing on `config['GLOBAL_FORCE_MULT']` being
   * undefined -- see main.js's own note on that.)
   *
   * `this.boost` (see _updateTransitionBoost above) scales the modulation
   * DEPTH on top of `strength`, not the base config values themselves --
   * so a detected transition makes the existing per-band motion swing
   * further from rest for a couple seconds, then fluidly eases back to
   * baseline reactivity as boost decays, rather than jumping to a
   * separate, discontinuous "transition look." At boost=0 (the normal
   * case) this is identical to plain per-band modulation.
   *
   * @param {object} base
   * @param {number} strength - 0..2ish, scales the whole effect. 0 means
   *   "keep analyzing but don't touch the config" -- useful as a live
   *   on/off without tearing down the AnalyserNode.
   * @param {object} routing - field -> {band, amount}, see DEFAULT_ROUTING.
   *   Defaults to DEFAULT_ROUTING; main.js's mix panel passes a live-edited
   *   copy instead.
   * @param {number} transitionIntensity - replaces the module-level
   *   BOOST_EXTRA constant when the caller wants it user-adjustable (see
   *   main.js's "transition intensity" slider).
   */
  applyTo(base, strength = 1, routing = DEFAULT_ROUTING, transitionIntensity = BOOST_EXTRA) {
    const depth = strength * (1 + this.boost * transitionIntensity)
    const out = { ...base }
    for (const field of Object.keys(FIELD_KINDS)) {
      const route = routing[field]
      if (!route || route.band === 'off') continue
      const bandValue = this.bands[route.band] ?? 0
      const delta = bandValue * route.amount * depth
      switch (FIELD_KINDS[field]) {
        case 'mult':
          out[field] = base[field] * (1 + delta)
          break
        case 'add':
          out[field] = base[field] + delta
          break
        case 'sub':
          out[field] = base[field] - delta
          break
        case 'add-clamp01':
          out[field] = clamp(base[field] + delta, 0, 1)
          break
        case 'add-centered':
          // Bipolar around the band's own midpoint (0.5), not 0..1 --
          // sensor_angle can swing either direction, so a bass hit
          // shouldn't only ever push it one way.
          out[field] = base[field] + (bandValue - 0.5) * route.amount * depth
          break
        case 'add-floor0':
          out[field] = Math.max(0, base[field] + delta)
          break
      }
    }
    return out
  }
}

/**
 * Which band drives which physics field, and how strongly -- the part of
 * the mapping main.js's "customize reactions" mix panel lets a person
 * edit live. `band` is 'low' | 'mid' | 'high' | 'off' ('off' leaves that
 * field at its base value, unmodulated). `amount` is the same per-field
 * coefficient the original hardcoded mapping used (e.g. global_force_mult
 * swinging by 1.5x band energy, vs. strafe_power's much subtler 0.1) --
 * kept as each field's own starting point since they're calibrated to
 * that field's own natural range, not directly comparable across fields.
 *
 * Rationale for the ORIGINAL band assignment, still the default: different
 * bands drive different KINDS of motion rather than one scalar driving
 * everything, so bass-heavy and treble-heavy passages actually look
 * different instead of the whole thing just pulsing uniformly -- bass
 * (low) -> force/weight, reads as a push/thump; mids -> structure, shifts
 * the overall shape of the flow; treble (high) -> fine detail/jitter,
 * reads as fast, twitchy motion. Re-routing a field to a different band
 * (via the mix panel) breaks that original pairing on purpose, if that's
 * what someone wants to explore.
 */
export const DEFAULT_ROUTING = {
  global_force_mult: { band: 'low', amount: 1.5 },
  axial_force: { band: 'low', amount: 0.4 },
  trail_persistence: { band: 'mid', amount: 0.15 },
  sensor_angle: { band: 'mid', amount: 0.3 },
  drag: { band: 'high', amount: 0.2 },
  strafe_power: { band: 'high', amount: 0.1 }
}

/**
 * HOW each field combines with its routed band -- fixed, not exposed to
 * the mix panel, because it's tied to what that physics param structurally
 * IS, not a style choice: global_force_mult is itself a multiplier, so it
 * scales multiplicatively; trail_persistence is a normalized 0..1 value,
 * so it clamps; sensor_angle can swing either direction, so it's bipolar
 * around the band's midpoint rather than always-positive; strafe_power
 * can't go negative, so it floors at 0. Letting the mix panel reassign
 * BAND per field is a real creative choice; letting it reassign KIND would
 * just produce broken-looking output (e.g. a clamped angle, or a
 * multiplicative trail_persistence blowing past 1).
 */
const FIELD_KINDS = {
  global_force_mult: 'mult',
  axial_force: 'add',
  trail_persistence: 'add-clamp01',
  sensor_angle: 'add-centered',
  drag: 'sub',
  strafe_power: 'add-floor0'
}

function binRangesForBands(binCount, sampleRate) {
  const nyquist = sampleRate / 2
  const hzPerBin = nyquist / binCount
  const range = (from, to) => ({
    start: Math.max(0, Math.floor(from / hzPerBin)),
    end: Math.min(binCount - 1, Math.ceil(to / hzPerBin))
  })
  return {
    low: range(BAND_EDGES.low.from, BAND_EDGES.low.to),
    mid: range(BAND_EDGES.mid.from, BAND_EDGES.mid.to),
    high: range(BAND_EDGES.high.from, BAND_EDGES.high.to)
  }
}

function averageEnergy(freqData, { start, end }) {
  let sum = 0
  for (let i = start; i <= end; i++) sum += freqData[i]
  return sum / (end - start + 1) / 255 // 0..1
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

// Wired into main.js's frame() loop and the "Audio" controls in index.html
// -- see main.js for the actual hookup (search for "audioDriver").
