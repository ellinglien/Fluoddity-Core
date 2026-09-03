/**
 * Main orchestrator for Fluoddity WebGL 2 port.
 * Creates the WebGL context, particle system, and wires together
 * the state, input, UI, and logging modules.
 */

import { ParticleSystem } from './particle_system.js';
import { computeEntityRule, generateRandomCenters, mutateRule } from './rule_utils.js';
import { RuleHistory, fetchConfig, createAppState, registerConfig } from './state.js';
import { setupKeyboard, setupMouse, setupScroll, screenToWorld, updateCamera } from './input.js';
import {
    setupUI,
    updateModeDisplay,
    updateInitialConditionsDisplay,
    updateMutationScaleDisplay,
    updateCohortsDisplay,
    formatPresetName
} from './ui.js';
import { createLogger } from './log.js';
import { calibrate } from './calibrate.js';
import {
    sourceFromFile,
    sourceFromInputDevice,
    sourceFromDisplayMedia,
    listAudioInputDevices,
    AudioReactiveDriver,
    DEFAULT_ROUTING
} from './audio.js';

// ─── Save/Load utilities (SIM7 cross-compatible format) ─────────────────────

async function zlibCompress(data) {
    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    writer.write(data);
    writer.close();
    const chunks = [];
    const reader = cs.readable.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}

async function zlibDecompress(data) {
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    writer.write(data);
    writer.close();
    const chunks = [];
    const reader = ds.readable.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}

function toUrlSafeBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_');
}

function fromUrlSafeBase64(str) {
    let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) {
        b64 += '=';
    }
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// Default sweep/jitter keys matching Python's PHYSICS_PARAM_NAMES
const PARAM_NAMES = [
    'SENSOR_GAIN', 'SENSOR_ANGLE', 'SENSOR_DISTANCE', 'MUTATION_SCALE',
    'GLOBAL_FORCE_MULT', 'DRAG', 'AXIAL_FORCE', 'LATERAL_FORCE',
    'STRAFE_POWER', 'TRAIL_PERSISTENCE', 'TRAIL_DIFFUSION', 'HAZARD_RATE',
];

function defaultSweeps() {
    const d = {};
    for (const p of PARAM_NAMES) d[p] = 0.0;
    return d;
}

function defaultJitters() {
    const d = {};
    for (const p of PARAM_NAMES) d[p] = 0.0;
    return d;
}

function defaultSliderRanges() {
    return {
        "Sensor Gain": [0.0, 5.0, 0.0, 5.0],
        "Sensor Angle": [-1.0, 1.0, -1.0, 1.0],
        "Sensor Distance": [0.0, 4.0, 0.0, 4.0],
        "Mutation Scale": [-0.5, 0.5, -0.5, 0.5],
        "Global Force Mult": [0.0, 2.0, 0.0, 2.0],
        "Drag": [-1.0, 1.0, -1.0, 1.0],
        "Axial Force": [-1.0, 1.0, -1.0, 1.0],
        "Lateral Force": [-1.0, 1.0, -1.0, 1.0],
        "Strafe Power": [0.0, 0.5, 0.0, 0.5],
        "Trail Persistence": [0.0, 1.0, 0.0, 1.0],
        "Trail Diffusion": [0.0, 1.0, 0.0, 1.0],
        "Hazard Rate": [0.0, 0.05, 0.0, 0.05],
    };
}

async function main() {
    const canvas = document.getElementById('canvas');
    const logger = createLogger(document.getElementById('error-display'));

    // Size canvas to window
    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    resize();

    // Get WebGL 2 context
    const gl = canvas.getContext('webgl2', { antialias: false });
    if (!gl) {
        logger.error('WebGL 2 is not supported by your browser.');
        return;
    }
    const ext = gl.getExtension('EXT_color_buffer_float');
    if (!ext) {
        logger.error('EXT_color_buffer_float extension not available. Float framebuffers are required.');
        return;
    }
    gl.getExtension('OES_texture_float_linear');

    // Load preset manifest
    let presetNames;
    try {
        const manifestResponse = await fetch('physics_configs/index.json', { cache: 'no-store' });
        if (!manifestResponse.ok) throw new Error(`HTTP ${manifestResponse.status}`);
        presetNames = await manifestResponse.json();
    } catch (e) {
        logger.error(`Failed to load preset manifest: ${e.message}`);
        return;
    }

    // ─── State ────────────────────────────────────────────────────────────────

    // Random on every load rather than always the manifest's first entry --
    // per direct feedback, seeing the same starting preset every time got
    // stale.
    let currentPresetName = presetNames[Math.floor(Math.random() * presetNames.length)];
    let config;
    try {
        config = await fetchConfig(currentPresetName);
    } catch (e) {
        logger.error(`Failed to load config: ${e.message}`);
        return;
    }

    const state = createAppState();
    const ruleHistory = new RuleHistory();
    ruleHistory.push(config.rule, config.rule_seed);

    // ─── Particle system ──────────────────────────────────────────────────────

    let worldSize = parseFloat(document.getElementById('world-size-selector').value);
    const aspectRatio = window.innerWidth / window.innerHeight;
    const system = new ParticleSystem(gl, config, worldSize, aspectRatio);
    try {
        await system.init();
    } catch (e) {
        logger.error(`Initialization failed: ${e.message}`);
        console.error(e);
        return;
    }

    // ─── Actions (callbacks for input/UI modules) ─────────────────────────────

    function applyConfig(newConfig) {
        config = newConfig;
        system.setConfig(config);
        updateInitialConditionsDisplay(ui.el, config);
        updateMutationScaleDisplay(ui.el, config);
        updateCohortsDisplay(ui.el, config);
    }

    function applyRule(rule, seed) {
        config = { ...config, rule: Array.from(rule), rule_seed: seed };
        system.setConfig(config);
    }

    function performUndo() {
        const prev = ruleHistory.pop();
        if (prev) {
            applyRule(prev.rule, prev.seed);
        }
    }

    function toggleMode() {
        state.mouseMode = state.mouseMode === 'select' ? 'draw' : 'select';
        updateModeDisplay(ui.el, state);
        if (state.mouseMode === 'select') {
            system.setTrailDrawState({ x: 0, y: 0, prevX: 0, prevY: 0, radius: 0, power: 0 });
        }
    }

    function togglePause() {
        state.paused = !state.paused;
    }

    function resetSimulation() {
        system.reset();
    }

    function randomizeSeed() {
        const current = ruleHistory.current();
        if (!current) return;
        const newSeed = Math.random();
        ruleHistory.push(current.rule, newSeed);
        applyRule(current.rule, newSeed);
    }

    // An all-zero rule is a signal entity_update.frag already understands
    // (see its "Generate random rule if config rule is all zeros" branch):
    // every cohort generates its OWN independent random rule instead of
    // mutating one shared rule by Mutation Scale. That branch has been in the
    // shader since the original port but nothing ever triggered it -- this is
    // the trigger.
    function randomizeBehavior() {
        const zeroRule = new Array(80).fill(0);
        const newSeed = Math.random();
        ruleHistory.push(zeroRule, newSeed);
        applyRule(zeroRule, newSeed);
    }


    function cycleInitialConditions() {
        const current = config.initial_conditions || 0;
        config.initial_conditions = (current + 1) % 3;
        system.setConfig(config);
        updateInitialConditionsDisplay(ui.el, config);
    }

    function selectParticleAt(clientX, clientY) {
        const cam = state.fancyCamera ? state.camera : null;
        const world = screenToWorld(canvas, clientX, clientY, cam, cam ? system.c : null);
        const data = system.readEntityData();
        const c = system.c;

        let bestDist = Infinity;
        let bestIndex = -1;
        for (let i = 0; i < c.entityCount; i++) {
            const base = i * 4;
            const dx = data[base] - world.x;
            const dy = data[base + 1] - world.y;
            const dist = dx * dx + dy * dy;
            if (dist < bestDist) {
                bestDist = dist;
                bestIndex = i;
            }
        }
        if (bestIndex < 0) return;

        const entityRule = computeEntityRule(
            config.rule, config.rule_seed, config.mutation_scale,
            config.cohorts, bestIndex, c.entityCount
        );
        ruleHistory.push(Array.from(entityRule), config.rule_seed);
        applyRule(entityRule, config.rule_seed);
    }

    function changeWorldSize(newSize) {
        worldSize = newSize;
        const ar = window.innerWidth / window.innerHeight;
        system.reinitGPU(worldSize, ar);
        // Reset camera when world size changes
        state.camera.posX = 0;
        state.camera.posY = 0;
        state.camera.zoom = 1.0;
    }

    async function saveConfig() {
        const v7 = {
            version: 7,
            physics: {
                sensor_gain: config.sensor_gain,
                sensor_angle: config.sensor_angle,
                sensor_distance: config.sensor_distance,
                mutation_scale: config.mutation_scale,
                global_force_mult: config.global_force_mult,
                drag: config.drag,
                strafe_power: config.strafe_power,
                axial_force: config.axial_force,
                lateral_force: config.lateral_force,
                hazard_rate: config.hazard_rate,
                trail_persistence: config.trail_persistence,
                trail_diffusion: config.trail_diffusion,
            },
            slider_ranges: defaultSliderRanges(),
            sweeps: { x: defaultSweeps(), y: defaultSweeps(), cohort: defaultSweeps() },
            jitters: defaultJitters(),
            parameter_sweeps_enabled: false,
            settings: {
                disable_symmetry: false,
                absolute_orientation: 0,
                orientation_mix: 1.0,
                boundary_conditions: 0,
                initial_conditions: config.initial_conditions || 0,
                cohort_fences: config.cohort_fences || false,
                num_cohorts: config.cohorts,
                rule_seed: config.rule_seed,
            },
            appearance: {
                ink_weight: 1.0,
                hue_sensitivity: 0.5,
                color_by_cohort: true,
                watercolor_mode: false,
                emboss_mode: 0,
                emboss_intensity: 0.5,
                emboss_smoothness: 0.1,
            },
            rule: Array.from(config.rule),
            notes: "",
        };
        try {
            const jsonBytes = new TextEncoder().encode(JSON.stringify(v7));
            const compressed = await zlibCompress(jsonBytes);
            const saveString = 'SIM7:' + toUrlSafeBase64(compressed);
            await navigator.clipboard.writeText(saveString);
            console.log(`Config saved to clipboard (${saveString.length} chars)`);
        } catch (err) {
            logger.error(`Save failed: ${err.message}`);
        }
    }

    async function loadConfigFromClipboard() {
        try {
            const text = (await navigator.clipboard.readText()).trim();
            if (!text.startsWith('SIM')) {
                logger.error('Clipboard does not contain a valid Fluoddity config');
                return;
            }
            const colonIdx = text.indexOf(':');
            if (colonIdx === -1) {
                logger.error('Invalid config format');
                return;
            }
            const version = parseInt(text.substring(3, colonIdx), 10);
            if (version !== 7) {
                logger.error(`Unsupported config version: ${version} (expected 7)`);
                return;
            }
            const encoded = text.substring(colonIdx + 1);
            const compressed = fromUrlSafeBase64(encoded);
            const jsonBytes = await zlibDecompress(compressed);
            const data = JSON.parse(new TextDecoder().decode(jsonBytes));

            const newConfig = {
                cohorts: data.settings.num_cohorts,
                rule_seed: data.settings.rule_seed,
                sensor_gain: data.physics.sensor_gain,
                sensor_angle: data.physics.sensor_angle,
                sensor_distance: data.physics.sensor_distance,
                mutation_scale: data.physics.mutation_scale,
                global_force_mult: data.physics.global_force_mult,
                drag: data.physics.drag,
                strafe_power: data.physics.strafe_power,
                axial_force: data.physics.axial_force,
                lateral_force: data.physics.lateral_force,
                hazard_rate: data.physics.hazard_rate,
                trail_persistence: data.physics.trail_persistence,
                trail_diffusion: data.physics.trail_diffusion,
                rule: data.rule,
                initial_conditions: data.settings.initial_conditions !== undefined ? data.settings.initial_conditions : 0,
                cohort_fences: data.settings.cohort_fences !== undefined ? data.settings.cohort_fences : false,
            };

            applyConfig(newConfig);
            ruleHistory.reset(newConfig.rule, newConfig.rule_seed);
            ui.el.presetTrigger.textContent = '(Pasted)';
            currentPresetName = null;
            console.log('Config loaded from clipboard');
        } catch (err) {
            logger.error(`Load failed: ${err.message}`);
        }
    }

    // Dropdown needs a way to register its closeDropdown for keyboard use
    let closeDropdownFn = null;

    // ─── Wire up UI ───────────────────────────────────────────────────────────

    const ui = setupUI(presetNames, currentPresetName, state, {
        toggleMode,
        performUndo,
        resetSimulation,
        applyConfig,
        changeWorldSize,
        cycleInitialConditions,
        onMutationScaleChange(value) {
            config.mutation_scale = value;
            system.setConfig(config);
        },
        onCohortsChange(value) {
            config.cohorts = value;
            system.setConfig(config);
        },
        onCohortFencesChange(checked) {
            config.cohort_fences = checked;
            system.setConfig(config);
        },
        getCurrentPresetName: () => currentPresetName,
        setCurrentPresetName: (name) => { currentPresetName = name; },
        snapshotConfig: () => ({ ...config, rule: Array.from(config.rule) }),
        finalizePresetLoad(newConfig) {
            config = newConfig;
            system.setConfig(config);
            ruleHistory.reset(config.rule, config.rule_seed);
            updateInitialConditionsDisplay(ui.el, config);
            updateMutationScaleDisplay(ui.el, config);
            updateCohortsDisplay(ui.el, config);
        },
        registerCloseDropdown(fn) { closeDropdownFn = fn; },
        logError: (msg) => logger.error(msg),
    });

    // ─── Generated presets ──────────────────────────────────────────────────
    // A preset's `rule` is just a flat 80-float array (10 Fourier centers,
    // 4-float frequency + 4-float amplitude each -- see entity_update.frag).
    // rule_utils.js already has bit-exact ports of the shader's own
    // generation/mutation math (used for cohort variation within one
    // preset); reused here at a much larger scale to make whole NEW
    // presets. Physics params come from a real existing preset (or a blend
    // of two) rather than randomized from scratch -- there's no reliable
    // per-field bounds available at runtime (each preset file's own
    // slider_ranges isn't parsed into the loaded-config shape), so
    // borrowing known-good values avoids producing broken-looking results.
    const PHYSICS_FIELDS = [
        'sensor_gain',
        'sensor_angle',
        'sensor_distance',
        'mutation_scale',
        'global_force_mult',
        'drag',
        'strafe_power',
        'axial_force',
        'lateral_force',
        'hazard_rate',
        'trail_persistence',
        'trail_diffusion'
    ];
    const GENERATED_PRESETS_STORAGE_KEY = 'fluaudio-generated-presets';
    // {name, config} pairs, persisted to localStorage as a whole array
    // after each generation -- per-browser only (this is a static site,
    // there's no backend to share these with anyone else visiting the
    // link). Kept so the full set can be re-saved without re-reading
    // localStorage each time.
    let generatedPresets = [];

    function uniqueGeneratedName(base) {
        if (!presetNames.includes(base)) return base;
        let i = 2;
        while (presetNames.includes(`${base}${i}`)) i++;
        return `${base}${i}`;
    }

    // Mirrors ui.js's own setupDropdown item structure exactly -- the
    // dropdown's hover-preview/click handlers are delegated from its
    // parent (el.presetMenu), so a plain appended child is immediately
    // fully functional, no extra wiring needed here.
    function addDropdownItem(name) {
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.dataset.preset = name;
        item.textContent = formatPresetName(name);
        ui.el.presetMenu.appendChild(item);
    }

    // Only the most recent few are worth carrying between sessions. Without a
    // cap the list grows without bound -- a single audio session generates one
    // per transition, so a long listen adds dozens, they restore on the next
    // load, and the dropdown (13 built-ins) ends up hundreds of entries long.
    // Past the localStorage quota the write throws and is silently swallowed,
    // so saving would just stop working with no signal.
    const MAX_SAVED_PRESETS = 25;

    function saveGeneratedPresets() {
        try {
            const keep = generatedPresets.slice(-MAX_SAVED_PRESETS);
            localStorage.setItem(GENERATED_PRESETS_STORAGE_KEY, JSON.stringify(keep));
        } catch {
            // localStorage unavailable (e.g. private mode) -- generated
            // presets just won't survive a reload, not worth surfacing.
        }
    }

    // Registers a newly generated {name, config} everywhere a real preset
    // already is: the fetchConfig cache, presetNames (so it's eligible as a
    // source for LATER generation too -- generateNewPreset's mutate/
    // crossover strategies pick from presetNames, so generated presets
    // keep compounding into further variety over a session), and the
    // visible dropdown. Shared by both fresh generation and startup
    // restoration from localStorage.
    function registerGeneratedPreset(name, config) {
        registerConfig(name, config);
        presetNames.push(name);
        addDropdownItem(name);
    }

    // Restore any presets generated in an earlier session on this browser.
    for (const { name, config: savedConfig } of loadSavedGeneratedPresets().slice(-MAX_SAVED_PRESETS)) {
        registerGeneratedPreset(name, savedConfig);
        generatedPresets.push({ name, config: savedConfig });
    }

    function loadSavedGeneratedPresets() {
        try {
            const raw = localStorage.getItem(GENERATED_PRESETS_STORAGE_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch {
            return [];
        }
    }

    /**
     * Generates one new preset via a randomly-picked strategy and switches
     * to it immediately (generating something and not seeing it defeats
     * the point):
     *   - fresh random rule (generateRandomCenters) + one real preset's
     *     physics, 25% of the time
     *   - one real preset's rule, mutated far more aggressively than any
     *     per-cohort mutation_scale would (those stay under ~0.3; this
     *     goes well past that) -- same KIND of change rule_utils.js's own
     *     mutateRule already does, just bigger, 40% of the time
     *   - a crossover: two real presets' rules AND physics linearly
     *     blended by the same random factor (kept away from the extremes
     *     so it isn't just "basically preset A"), 35% of the time
     */
    // `persist` distinguishes intent. Pressing Generate (or N) is a deliberate
    // act and the result is worth keeping. A preset generated by an audio
    // transition is part of the performance -- it plays for a few seconds and
    // is gone, so it stays in the session (still selectable, still a source for
    // later generation) but never reaches localStorage.
    async function generateNewPreset({ persist = true } = {}) {
        try {
            const roll = Math.random();
            let newRule;
            let physicsSource;
            let name;

            if (roll < 0.25) {
                newRule = Array.from(generateRandomCenters(Math.random()));
                const sourceName = presetNames[Math.floor(Math.random() * presetNames.length)];
                physicsSource = await fetchConfig(sourceName);
                name = uniqueGeneratedName(`Generated${Math.floor(Math.random() * 10000)}`);
            } else if (roll < 0.65) {
                const sourceName = presetNames[Math.floor(Math.random() * presetNames.length)];
                const source = await fetchConfig(sourceName);
                newRule = Array.from(source.rule);
                mutateRule(newRule, 0.6 + Math.random() * 0.8, Math.random());
                physicsSource = source;
                name = uniqueGeneratedName(`${sourceName}Mutant`);
            } else {
                const nameA = presetNames[Math.floor(Math.random() * presetNames.length)];
                const otherNames = presetNames.filter((n) => n !== nameA);
                const nameB = otherNames[Math.floor(Math.random() * otherNames.length)];
                const [a, b] = await Promise.all([fetchConfig(nameA), fetchConfig(nameB)]);
                const t = 0.3 + Math.random() * 0.4;
                newRule = a.rule.map((v, i) => v * (1 - t) + b.rule[i] * t);
                physicsSource = { ...a };
                for (const field of PHYSICS_FIELDS) {
                    physicsSource[field] = a[field] * (1 - t) + b[field] * t;
                }
                name = uniqueGeneratedName(`${nameA}${nameB}`);
            }

            // cohort_fences is a session toggle, not something any preset file
            // actually specifies (loadConfig always defaults it false for a
            // preset that doesn't set it) -- carry the CURRENT value across
            // instead of silently dropping it every time a new preset is
            // generated.
            const newConfig = { ...physicsSource, rule: newRule, rule_seed: Math.random(), cohort_fences: config.cohort_fences || false };

            registerGeneratedPreset(name, newConfig);
            if (persist) {
                generatedPresets.push({ name, config: newConfig });
                saveGeneratedPresets();
            }

            currentPresetName = name;
            ui.el.presetTrigger.textContent = formatPresetName(name);
            config = newConfig;
            system.setConfig(config);
            ruleHistory.reset(config.rule, config.rule_seed);
            updateInitialConditionsDisplay(ui.el, config);
            updateMutationScaleDisplay(ui.el, config);
            updateCohortsDisplay(ui.el, config);
        } catch (e) {
            logger.error(`Preset generation failed: ${e.message}`);
        }
    }

    document.getElementById('generate-preset-button').addEventListener('click', (e) => {
        e.currentTarget.blur();
        void generateNewPreset();
    });

    document.getElementById('randomize-behavior-button').addEventListener('click', (e) => {
        e.currentTarget.blur();
        randomizeBehavior();
    });

    // ─── Wire up input ───────────────────────────────────────────────────────

    setupKeyboard(state, {
        toggleMode,
        togglePause,
        resetSimulation,
        randomizeSeed,
        generateNewPreset: () => void generateNewPreset(),
        randomizeBehavior,
        closeDropdown: (restore) => closeDropdownFn && closeDropdownFn(restore),
        saveConfig,
        loadConfig: loadConfigFromClipboard,
    });

    setupMouse(canvas, state, {
        selectParticleAt,
        performUndo,
        setTrailDrawState: (s) => system.setTrailDrawState(s),
        getConstants: () => system.c,
    });

    setupScroll(canvas, state);

    // ─── Auto-detect optimal settings ────────────────────────────────────────

    {
        const ar = window.innerWidth / window.innerHeight;
        const optimal = calibrate(gl, system, ar);
        worldSize = optimal.worldSize;

        // Update UI to reflect calibrated values
        // Note: String(1.0) produces "1" which doesn't match option value "1.0",
        // so we match by numeric value instead.
        const wsOpts = ui.el.worldSizeSelector.options;
        for (let i = 0; i < wsOpts.length; i++) {
            if (parseFloat(wsOpts[i].value) === optimal.worldSize) {
                ui.el.worldSizeSelector.selectedIndex = i;
                break;
            }
        }
        ui.el.physicsFreqSlider.value = String(optimal.physicsSpeed);
        ui.el.physicsFreqValue.textContent = String(optimal.physicsSpeed);
    }
    document.getElementById('calibration-overlay').style.display = 'none';

    // ─── Controls popup ──────────────────────────────────────────────────────
    const controlsOverlay = document.getElementById('controls-overlay');
    const controlsButton = document.getElementById('controls-button');

    function showControlsPopup() { controlsOverlay.classList.remove('hidden'); }
    function hideControlsPopup() { controlsOverlay.classList.add('hidden'); }

    controlsOverlay.addEventListener('click', hideControlsPopup);
    controlsButton.addEventListener('click', () => { controlsButton.blur(); showControlsPopup(); });

    // Show on first load
    showControlsPopup();

    // Sync new controls with initially loaded config
    updateInitialConditionsDisplay(ui.el, config);
    updateMutationScaleDisplay(ui.el, config);
    updateCohortsDisplay(ui.el, config);

    // ─── Audio-reactive driver ──────────────────────────────────────────────────
    // See audio.js's own doc comment for the calibration reasoning (band
    // splitting, attack/release smoothing, auto-gain). `audioDriver` stays
    // null until a source is picked; frame() below only calls into it when
    // non-null, and setConfig always gets a fresh modulated COPY of `config`
    // (see applyConfig/setConfig usage elsewhere in this file) -- the saved
    // preset itself is never mutated, so stopping audio just means frame()
    // stops overwriting it.
    let audioDriver = null;
    let audioContext = null;

    const audioFileButton = document.getElementById('audio-file-button');
    const audioFileInput = document.getElementById('audio-file-input');
    const audioCaptureButton = document.getElementById('audio-capture-button');
    const audioInputSelector = document.getElementById('audio-input-selector');
    const audioStopButton = document.getElementById('audio-stop-button');
    const audioStatusRow = document.getElementById('audio-status-row');
    const audioStatus = document.getElementById('audio-status');
    const audioStrengthSlider = document.getElementById('audio-strength-slider');
    const audioStrengthValue = document.getElementById('audio-strength-value');
    const audioDebugPanel = document.getElementById('audio-debug-panel');

    // Fields applyTo() actually writes -- keeping this list next to the
    // panel rather than hardcoding six lines means it stays in sync if
    // audio.js's mapping ever grows/shrinks without a second edit here.
    // Lowercase_snake_case to match gl_utils.js's loadConfig() -- the real
    // shape of the live config object (NOT main.js's own uppercase
    // PARAM_NAMES, which is a separate, unused-in-Fluoddity-Core sweep/
    // jitter list -- mixing the two up here previously meant every value
    // this panel tried to read was undefined, which crashed the whole
    // frame() loop permanently on the very first frame audio was active,
    // since an uncaught throw here happens before the loop's own
    // requestAnimationFrame(frame) call at the bottom ever runs again).
    const AUDIO_MODULATED_FIELDS = [
        'global_force_mult',
        'axial_force',
        'trail_persistence',
        'sensor_angle',
        'drag',
        'strafe_power'
    ];

    // Never lets a formatting hiccup here take down the render loop the way
    // the bug above did -- shows 'n/a' instead of throwing on anything that
    // isn't a finite number.
    function fmtDebugValue(n) {
        if (typeof n !== 'number' || !Number.isFinite(n)) return ' n/a';
        return (n >= 0 ? ' ' : '') + n.toFixed(3);
    }

    function updateAudioDebugPanel(bands, boost, base, modulated) {
        const lines = [
            `bands   low ${fmtDebugValue(bands.low)}  mid ${fmtDebugValue(bands.mid)}  high ${fmtDebugValue(bands.high)}`,
            `transition boost  ${fmtDebugValue(boost)}${boost > 0.5 ? '  <- transition!' : ''}`,
            ''
        ];
        for (const field of AUDIO_MODULATED_FIELDS) {
            const band = audioRouting[field]?.band ?? 'off';
            lines.push(
                `${field.padEnd(18)} [${band.padEnd(4)}] ${fmtDebugValue(base[field])} -> ${fmtDebugValue(modulated[field])}`
            );
        }
        audioDebugPanel.textContent = lines.join('\n');
    }

    // Chrome (and others) create a new AudioContext in 'suspended' state
    // unless resume() is called from within a real user gesture -- without
    // this, everything downstream (decode, analyser, playback) runs with
    // no error at all, just silent zero-energy output, which is a much
    // more confusing failure than an exception would be (confirmed live:
    // window.__audioDriver.bands sat at {low:0, mid:0, high:0} forever,
    // no console output anywhere pointing at the cause). Safe to call even
    // when already 'running' -- resume() on a running context is a no-op.
    async function getOrCreateAudioContext() {
        audioContext = audioContext || new AudioContext();
        if (audioContext.state === 'suspended') await audioContext.resume();
        return audioContext;
    }

    // Tracks belonging to a live capture (tab/system audio or a mic), kept so
    // Stop can actually END the capture rather than just ignoring it. Without
    // this the browser's "sharing your screen" bar stays up after Stop, which
    // reads as the page still listening.
    let audioCaptureTracks = [];

    function releaseAudioCapture() {
        audioCaptureTracks.forEach((t) => t.stop());
        audioCaptureTracks = [];
    }

    // Switching sources (tab audio -> mic, or either -> a different pick)
    // must close the outgoing one first; otherwise the old capture stays
    // open forever, still holding the mic or the share indicator, with
    // nothing left pointing at it.
    function adoptAudioCapture(stream) {
        releaseAudioCapture();
        audioCaptureTracks = stream.getTracks();
    }

    function startAudioDriver(sourceNode, label) {
        audioDriver = new AudioReactiveDriver(audioContext, sourceNode);
        audioStatus.textContent = `audio: ${label}`;
        audioStatusRow.style.display = 'flex';
        audioDebugPanel.style.display = 'block';
        // Dev convenience -- lets you poke window.__audioDriver.bands from
        // devtools to see live band values while tuning applyTo()'s mapping.
        window.__audioDriver = audioDriver;
    }

    // ─── Capture whatever's playing in another tab/app ─────────────────────
    // The zero-setup path: no file to find, no loopback driver to install.
    // Chrome/Edge only -- Firefox and Safari implement getDisplayMedia but
    // drop the audio track, so feature-detecting the METHOD isn't enough and
    // we'd hand those users a button that always fails. Hide it there and
    // leave them the file/device routes, which work everywhere.
    const canCaptureDisplayAudio = !!navigator.mediaDevices?.getDisplayMedia
        && /Chrome|Edg/.test(navigator.userAgent)
        && !/Firefox/.test(navigator.userAgent);

    if (!canCaptureDisplayAudio) {
        audioCaptureButton.closest('.control-row').style.display = 'none';
    }

    audioCaptureButton.addEventListener('click', async () => {
        audioCaptureButton.blur();
        try {
            const ctx = await getOrCreateAudioContext();
            const node = await sourceFromDisplayMedia(ctx);

            // The picker lets you share a tab, a window or the whole screen,
            // but only a tab reliably carries audio -- so name what we got
            // rather than guessing.
            const track = node.mediaStream.getAudioTracks()[0];
            adoptAudioCapture(node.mediaStream);

            // Ending the share from Chrome's own "Stop sharing" bar has to
            // tear the driver down too, or the sim keeps reacting to a dead
            // analyser (silence) and the Stop button still claims it's live.
            track.addEventListener('ended', () => {
                if (audioDriver) stopAudio();
            });

            startAudioDriver(node, track.label || 'shared tab');
        } catch (e) {
            // Dismissing the picker is a normal choice, not an error worth
            // shouting about in the log.
            if (e.name === 'NotAllowedError' || e.name === 'AbortError') return;
            logger.error(`Couldn't capture app audio: ${e.message}`);
        }
    });

    audioFileButton.addEventListener('click', () => {
        audioFileButton.blur();
        audioFileInput.click();
    });

    audioFileInput.addEventListener('change', async () => {
        const file = audioFileInput.files[0];
        if (!file) return;
        try {
            const ctx = await getOrCreateAudioContext();
            const { node, start } = await sourceFromFile(ctx, file);
            startAudioDriver(node, file.name);
            start();
        } catch (e) {
            logger.error(`Failed to load audio file: ${e.message}`);
        }
    });

    // Device labels stay blank until permission has been granted at least
    // once (browser privacy restriction) -- populated lazily on first focus
    // rather than on page load, so opening this dropdown is itself the user
    // gesture that resolves the permission prompt. Re-populating on every
    // focus (not just once) picks up a loopback driver installed/removed,
    // or a device plugged in, after the page was already open.
    let audioInputDevicesLoading = false;
    async function populateAudioInputDevices() {
        if (audioInputDevicesLoading) return;
        audioInputDevicesLoading = true;
        try {
            // Request+immediately release a generic stream just to unlock
            // real device labels (e.g. "BlackHole 2ch") -- not to keep it;
            // the actual capture happens in the 'change' handler below,
            // scoped to whichever specific device gets picked.
            const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
            probe.getTracks().forEach((t) => t.stop());

            const devices = await listAudioInputDevices();
            const previousValue = audioInputSelector.value;
            audioInputSelector.innerHTML = '<option value="">Select input device...</option>';
            for (const device of devices) {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label || `Input device (${device.deviceId.slice(0, 8)})`;
                audioInputSelector.appendChild(option);
            }
            audioInputSelector.value = previousValue;
        } catch (e) {
            logger.error(`Couldn't list audio input devices: ${e.message}`);
        } finally {
            audioInputDevicesLoading = false;
        }
    }

    audioInputSelector.addEventListener('focus', populateAudioInputDevices);

    audioInputSelector.addEventListener('change', async () => {
        const deviceId = audioInputSelector.value;
        if (!deviceId) return;
        const label = audioInputSelector.options[audioInputSelector.selectedIndex].textContent;
        try {
            const ctx = await getOrCreateAudioContext();
            const node = await sourceFromInputDevice(ctx, deviceId);
            // Same reason as the capture path: Stop should actually close the
            // mic, not just stop reading it -- otherwise the browser's
            // recording indicator stays lit.
            adoptAudioCapture(node.mediaStream);
            startAudioDriver(node, label);
        } catch (e) {
            logger.error(`Failed to open "${label}": ${e.message}`);
        }
        audioInputSelector.blur();
    });

    function stopAudio() {
        audioDriver = null;
        releaseAudioCapture();
        audioStatusRow.style.display = 'none';
        audioDebugPanel.style.display = 'none';
        // Otherwise the dropdown keeps showing the now-inactive device as
        // "selected," and re-picking that same option wouldn't fire a
        // 'change' event to restart it.
        audioInputSelector.value = '';
        // Revert to the plain preset immediately rather than waiting for the
        // next slider/preset change -- otherwise the last audio-modulated
        // config lingers on screen looking like a stuck knob.
        system.setConfig(config);
    }

    audioStopButton.addEventListener('click', stopAudio);

    audioStrengthSlider.addEventListener('input', () => {
        audioStrengthValue.textContent = parseFloat(audioStrengthSlider.value).toFixed(2);
    });
    audioStrengthSlider.addEventListener('change', () => audioStrengthSlider.blur());

    // ─── Mix panel: customize which band drives which reaction ─────────────
    // A live-edited COPY of audio.js's DEFAULT_ROUTING -- the driver itself
    // stays stateless about routing (see AudioReactiveDriver.applyTo's
    // `routing` param), this object is the only thing the mix panel below
    // actually mutates. structuredClone rather than a shallow copy since
    // DEFAULT_ROUTING's values are themselves objects ({band, amount}) --
    // a shallow copy would let editing audioRouting.drag.amount silently
    // mutate audio.js's own DEFAULT_ROUTING export too.
    const audioRouting = structuredClone(DEFAULT_ROUTING);
    let transitionIntensity = 0.5;

    // Label + slider ceiling per field -- ceilings are sized relative to
    // each field's own DEFAULT_ROUTING amount (roughly 3x it), not one
    // shared range, since e.g. global_force_mult's useful range (~0-4) and
    // strafe_power's (~0-0.5) are wildly different scales.
    const MIX_FIELD_META = {
        global_force_mult: { label: 'Push', max: 4 },
        axial_force: { label: 'Thrust', max: 1.5 },
        trail_persistence: { label: 'Trails', max: 0.5 },
        sensor_angle: { label: 'Shape', max: 1 },
        drag: { label: 'Drag', max: 1 },
        strafe_power: { label: 'Jitter', max: 0.5 }
    };

    // Populated below, one entry per field -- the dice/randomize button's
    // handler (after Glow's own setup further down) uses this to update
    // both audioRouting AND the visible controls together, rather than
    // reconstructing DOM references by querying back into audioMixRows.
    const mixRowControls = [];

    const audioMixRows = document.getElementById('audio-mix-rows');
    for (const [field, meta] of Object.entries(MIX_FIELD_META)) {
        const route = audioRouting[field];
        const row = document.createElement('div');
        row.className = 'audio-mix-row';

        const label = document.createElement('label');
        label.textContent = meta.label;

        const bandSelect = document.createElement('select');
        for (const band of ['off', 'low', 'mid', 'high']) {
            const opt = document.createElement('option');
            opt.value = band;
            opt.textContent = band === 'off' ? 'off' : band;
            if (band === route.band) opt.selected = true;
            bandSelect.appendChild(opt);
        }
        bandSelect.addEventListener('change', () => {
            route.band = bandSelect.value;
        });

        const amountSlider = document.createElement('input');
        amountSlider.type = 'range';
        amountSlider.min = '0';
        amountSlider.max = String(meta.max);
        amountSlider.step = String(meta.max / 100);
        amountSlider.value = String(route.amount);

        const amountValue = document.createElement('span');
        amountValue.className = 'mix-amount-value';
        amountValue.textContent = route.amount.toFixed(2);

        amountSlider.addEventListener('input', () => {
            route.amount = parseFloat(amountSlider.value);
            amountValue.textContent = route.amount.toFixed(2);
        });
        amountSlider.addEventListener('change', () => amountSlider.blur());

        row.append(label, bandSelect, amountSlider, amountValue);
        audioMixRows.appendChild(row);

        mixRowControls.push({ field, meta, route, bandSelect, amountSlider, amountValue });
    }

    // How big a loudness jump counts as a "transition" -- separate from
    // transitionIntensity above (that's how STRONG the response is once
    // triggered; this is how EASILY it triggers at all). Threaded onto
    // audioDriver.transitionRatio every frame in frame() below rather than
    // set once here, since audioDriver doesn't exist yet at setup time and
    // gets replaced whenever a new source is picked.
    let transitionSensitivity = 2.2;
    const audioSensitivitySlider = document.getElementById('audio-sensitivity-slider');
    const audioSensitivityValue = document.getElementById('audio-sensitivity-value');
    audioSensitivitySlider.addEventListener('input', () => {
        transitionSensitivity = parseFloat(audioSensitivitySlider.value);
        audioSensitivityValue.textContent = transitionSensitivity.toFixed(2);
    });
    audioSensitivitySlider.addEventListener('change', () => audioSensitivitySlider.blur());

    const audioTransitionSlider = document.getElementById('audio-transition-slider');
    const audioTransitionValue = document.getElementById('audio-transition-value');
    audioTransitionSlider.addEventListener('input', () => {
        transitionIntensity = parseFloat(audioTransitionSlider.value);
        audioTransitionValue.textContent = transitionIntensity.toFixed(1);
    });
    audioTransitionSlider.addEventListener('change', () => audioTransitionSlider.blur());

    // Global brightness glow, separate from the per-param routing above --
    // see AudioReactiveDriver.overallEnergy's own doc comment for why.
    // audioGlow is what frame()'s render call actually adds to the
    // brightness slider's own value each frame; reset to 0 whenever
    // there's no active driver (stop, or the error-handling fallback in
    // frame() below) so brightness doesn't get stuck boosted.
    let glowIntensity = 0.08;
    let audioGlow = 0;
    const audioGlowSlider = document.getElementById('audio-glow-slider');
    const audioGlowValue = document.getElementById('audio-glow-value');
    audioGlowSlider.addEventListener('input', () => {
        glowIntensity = parseFloat(audioGlowSlider.value);
        audioGlowValue.textContent = glowIntensity.toFixed(2);
    });
    audioGlowSlider.addEventListener('change', () => audioGlowSlider.blur());

    // Continuously-advancing hue rotation, same "simple global cue" spirit
    // as Glow but for color instead of brightness -- see cam_brush.vert's
    // own audio_hue_shift uniform, which every cohort's hue is offset by.
    // hueShiftAccumulator wraps 0..1 (a full trip around the color wheel)
    // and only advances while a driver is active -- it freezes (not
    // resets) once audio stops, so the palette doesn't jump back
    // noticeably, it just stops drifting.
    let hueShiftIntensity = 0.15;
    let hueShiftAccumulator = 0;
    const audioHueShiftSlider = document.getElementById('audio-hue-shift-slider');
    const audioHueShiftValue = document.getElementById('audio-hue-shift-value');
    audioHueShiftSlider.addEventListener('input', () => {
        hueShiftIntensity = parseFloat(audioHueShiftSlider.value);
        audioHueShiftValue.textContent = hueShiftIntensity.toFixed(2);
    });
    audioHueShiftSlider.addEventListener('change', () => audioHueShiftSlider.blur());

    // 🎲 Randomizes which band drives each reaction (and how strongly),
    // plus Glow -- a quick way to explore combinations without tweaking
    // six rows by hand. Deliberately does NOT touch Sensitivity/
    // Transitions/Beat Delay/the two checkboxes -- those are about
    // DETECTION and timing behavior, not "which reaction does what," a
    // different kind of knob than this button/randomizeReactions is for.
    // Also called once at startup (see below) so every fresh load starts
    // from its own random mix rather than always DEFAULT_ROUTING.
    function randomizeReactions() {
        for (const { meta, route, bandSelect, amountSlider, amountValue } of mixRowControls) {
            const bands = ['off', 'low', 'mid', 'high'];
            route.band = bands[Math.floor(Math.random() * bands.length)];
            route.amount = Math.random() * meta.max;

            bandSelect.value = route.band;
            amountSlider.value = String(route.amount);
            amountValue.textContent = route.amount.toFixed(2);
        }

        glowIntensity = Math.random() * parseFloat(audioGlowSlider.max);
        audioGlowSlider.value = String(glowIntensity);
        audioGlowValue.textContent = glowIntensity.toFixed(2);
    }

    document.getElementById('audio-randomize-button').addEventListener('click', (e) => {
        e.currentTarget.blur();
        randomizeReactions();
    });

    randomizeReactions();

    // Whether a detected transition also re-rolls the mutation seed (see
    // frame()'s own use of audioDriver.transitionJustFired below) -- a
    // checkbox rather than always-on since it's a much more disruptive
    // effect than the parameter surge (an actual behavior change, not just
    // a bigger version of the current one) and someone might want the
    // surge without the mutation.
    let mutateOnTransition = true;
    document.getElementById('audio-mutate-on-transition').addEventListener('change', (e) => {
        mutateOnTransition = e.target.checked;
    });

    // A full preset swap is a much bigger, more disruptive event than the
    // parameter-surge boost -- capped to at most once a minute, separate
    // from (and much longer than) audio.js's own 6s TRANSITION_COOLDOWN_MS,
    // which paces detection/the boost envelope itself, not this. Per
    // direct feedback: even a 6s-spaced preset swap read as too frequent
    // once "mutate on transition" started doing a full swap instead of a
    // same-family reseed. (Was briefly 3 minutes, shortened to 1.)
    const MUTATE_ON_TRANSITION_COOLDOWN_MS = 60 * 1000;
    let lastMutateOnTransitionAt = -Infinity;

    // Whether a detected transition waits for the next bar-aligned onset
    // to actually fire (see audio.js's own quantizeToBar doc comment) --
    // threaded onto audioDriver.quantizeToBar every frame below, same
    // "audioDriver doesn't exist yet at setup time" reasoning as
    // transitionSensitivity above.
    let quantizeToBar = true;
    document.getElementById('audio-quantize-to-bar').addEventListener('change', (e) => {
        quantizeToBar = e.target.checked;
    });

    // How much later (ms) a bar-quantized commit fires, past the bar-
    // boundary onset that scheduled it -- see audio.js's own beatDelayMs
    // doc comment. Live-input-only tuning knob; harmless (just an extra
    // fixed delay) if left on for file playback too.
    let beatDelayMs = 0;
    const audioBeatDelaySlider = document.getElementById('audio-beat-delay-slider');
    const audioBeatDelayValue = document.getElementById('audio-beat-delay-value');
    audioBeatDelaySlider.addEventListener('input', () => {
        beatDelayMs = parseFloat(audioBeatDelaySlider.value);
        audioBeatDelayValue.textContent = `${beatDelayMs}ms`;
    });
    audioBeatDelaySlider.addEventListener('change', () => audioBeatDelaySlider.blur());

    // ─── BPM-adjusted speed ──────────────────────────────────────────────────
    // Reference tempo the Speed slider's own value is treated as matching --
    // 120 is the least arbitrary choice available (the most common "neutral"
    // dance-music tempo), not tuned against anything in particular. See
    // frame()'s own physicsFrequency computation for where this is used.
    const BPM_SPEED_REFERENCE = 120;
    let bpmAdjustsSpeed = true;
    const audioBpmValue = document.getElementById('audio-bpm-value');
    document.getElementById('audio-bpm-speed-enabled').addEventListener('change', (e) => {
        bpmAdjustsSpeed = e.target.checked;
    });

    // ─── Hide UI ("just the images") ────────────────────────────────────────
    // H toggles every overlay/panel off via one body class (see index.html's
    // own body.ui-hidden rule) -- not tied to Fluoddity's own setupKeyboard
    // input.js system, since this is a pure DOM/CSS concern with nothing to
    // do with the particle sim itself. Same "don't capture while typing in a
    // field" guard input.js's own keyboard handling uses.
    window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        if (e.key === 'h' || e.key === 'H') {
            document.body.classList.toggle('ui-hidden');
        }
    });

    // ─── Resize ───────────────────────────────────────────────────────────────

    let resizeTimeout = null;
    window.addEventListener('resize', () => {
        resize();
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            const ar = window.innerWidth / window.innerHeight;
            system.reinitGPU(worldSize, ar);
        }, 300);
    });

    // ─── Render loop ──────────────────────────────────────────────────────────

    let lastFrameTime = performance.now();

    function frame() {
        const now = performance.now();
        const dt = Math.min((now - lastFrameTime) / 1000.0, 0.05);
        lastFrameTime = now;

        updateCamera(state, dt);

        // try/catch specifically here, not just around this one feature for
        // its own sake -- ANY uncaught throw inside frame() kills the whole
        // render loop forever (requestAnimationFrame(frame) at the bottom of
        // this function never runs again once something above it throws).
        // Audio-reactivity is the newest, least battle-tested code path in
        // this file, so it's the one most likely to regress that way again;
        // isolating it means a bug here degrades to "audio stops reacting"
        // instead of "the whole sketch freezes."
        if (audioDriver) {
            try {
                // Before update() -- it's what actually reads these.
                audioDriver.transitionRatio = transitionSensitivity;
                audioDriver.quantizeToBar = quantizeToBar;
                audioDriver.beatDelayMs = beatDelayMs;
                audioDriver.update();
                // generateNewPreset is async (see its own doc comment) --
                // its system.setConfig lands on a later frame once
                // generation resolves, not this one, so there's no
                // same-frame ordering concern with
                // applyTo()/system.setConfig(modulated) below.
                if (
                    audioDriver.transitionJustFired &&
                    mutateOnTransition &&
                    performance.now() - lastMutateOnTransitionAt > MUTATE_ON_TRANSITION_COOLDOWN_MS
                ) {
                    lastMutateOnTransitionAt = performance.now();
                    void generateNewPreset({ persist: false });
                }
                const modulated = audioDriver.applyTo(
                    config,
                    parseFloat(audioStrengthSlider.value),
                    audioRouting,
                    transitionIntensity
                );
                system.setConfig(modulated);
                updateAudioDebugPanel(audioDriver.bands, audioDriver.boost, config, modulated);
                audioGlow = audioDriver.overallEnergy * glowIntensity * parseFloat(audioStrengthSlider.value);
                hueShiftAccumulator =
                    (hueShiftAccumulator +
                        audioDriver.overallEnergy * hueShiftIntensity * parseFloat(audioStrengthSlider.value) * dt) %
                    1;
                audioBpmValue.textContent = audioDriver.bpm === null ? '--' : Math.round(audioDriver.bpm);
            } catch (e) {
                logger.error(`Audio-reactive driver failed, stopping: ${e.message}`);
                audioDriver = null;
                audioStatusRow.style.display = 'none';
                audioDebugPanel.style.display = 'none';
                system.setConfig(config);
                audioGlow = 0;
                audioBpmValue.textContent = '--';
            }
        } else {
            audioGlow = 0;
            audioBpmValue.textContent = '--';
        }

        if (!state.paused) {
            // Scaled by (detected bpm / 120) when a driver is active, has a
            // confident tempo estimate, and the "adjust speed" checkbox is
            // on -- the Speed slider's OWN value never changes, only this
            // effective per-frame count, same "audio modulates on top of
            // the manual baseline" pattern as brightness/glow above.
            let physicsFrequency = parseInt(ui.el.physicsFreqSlider.value, 10);
            if (audioDriver && bpmAdjustsSpeed && audioDriver.bpm !== null) {
                const scaled = physicsFrequency * (audioDriver.bpm / BPM_SPEED_REFERENCE);
                physicsFrequency = Math.max(1, Math.min(40, Math.round(scaled)));
            }

            if (state.mouseMode === 'draw' && state.mouseDown) {
                system.setTrailDrawState({
                    x: state.mousePos.x,
                    y: state.mousePos.y,
                    prevX: state.prevMousePos.x,
                    prevY: state.prevMousePos.y,
                    radius: parseFloat(ui.el.drawSizeSlider.value),
                    power: parseFloat(ui.el.drawPowerSlider.value),
                });
            }

            for (let i = 0; i < physicsFrequency; i++) {
                system.advance();
            }

            if (state.mouseMode === 'draw' && state.mouseDown) {
                state.prevMousePos = { ...state.mousePos };
            }

            if (state.mouseMode === 'draw' && !state.mouseDown) {
                system.setTrailDrawState({ x: 0, y: 0, prevX: 0, prevY: 0, radius: 0, power: 0 });
            }
        }

        // audioGlow (0 when no driver is active -- see above) rides on top
        // of the slider's own value rather than replacing it, and is
        // capped a bit above the slider's own 1.0 ceiling so the glow
        // stays visible even with brightness already maxed, without
        // letting it blow out arbitrarily far past that.
        const brightness = Math.min(1.2, parseFloat(ui.el.brightnessSlider.value) + audioGlow);
        system.renderDisplay(state.fancyCamera, state.camera, brightness, hueShiftAccumulator);
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

main();
