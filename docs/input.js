/**
 * Input module: keyboard and mouse event binding.
 * Converts raw DOM events into action callbacks provided by the orchestrator.
 */

// ─── Coordinate conversion ──────────────────────────────────────────────────

export function screenToWorld(canvas, clientX, clientY, camera = null, constants = null) {
    const rect = canvas.getBoundingClientRect();
    const ndcX = (clientX - rect.left) / rect.width * 2.0 - 1.0;
    const ndcY = -((clientY - rect.top) / rect.height * 2.0 - 1.0);
    if (camera && constants) {
        // Invert the cam_brush.vert transform:
        //   ndc = vertex_pos * vec2(1, tex_aspect) * scale - cam_pos * vec2(1,-1) / cam_zoom
        // where scale = base_scale / cam_zoom
        // So: ndc * cam_zoom = vertex_pos * vec2(1, tex_aspect) * base_scale - cam_pos * vec2(1,-1)
        // Solving for vertex_pos (entity world position):
        const texAspect = constants.canvasWidth / constants.canvasHeight;
        const winAspect = canvas.width / canvas.height;
        let bsx, bsy;
        if (texAspect > winAspect) {
            bsx = 1.0;
            bsy = winAspect / texAspect;
        } else {
            bsx = texAspect / winAspect;
            bsy = 1.0;
        }
        const worldX = (ndcX * camera.zoom + camera.posX) / bsx;
        const worldY = (ndcY * camera.zoom - camera.posY) / (texAspect * bsy);
        return { x: worldX, y: worldY };
    }
    return { x: ndcX, y: ndcY };
}

export function screenToUV(canvas, clientX, clientY, camera = null, constants = null) {
    const rect = canvas.getBoundingClientRect();
    if (camera && constants) {
        // Convert screen position through camera to canvas UV.
        // entity_update.frag maps entity pos to canvas UV via:
        //   cuv = p / 2.0 * vec2(1, tex_aspect) + 0.5
        // So: u = entity.x / 2 + 0.5,  v = entity.y / 2 * tex_aspect + 0.5
        const world = screenToWorld(canvas, clientX, clientY, camera, constants);
        const texAspect = constants.canvasWidth / constants.canvasHeight;
        const u = world.x / 2.0 + 0.5;
        const v = world.y / 2.0 * texAspect + 0.5;
        return { x: u, y: v };
    }
    const u = (clientX - rect.left) / rect.width;
    const v = 1.0 - (clientY - rect.top) / rect.height;
    return { x: u, y: v };
}

// ─── Keyboard ───────────────────────────────────────────────────────────────

/**
 * @param {object} state - shared AppState
 * @param {object} actions - callbacks:
 *   { toggleMode, performUndo, resetSimulation, randomizeSeed, generateNewPreset, randomizeBehavior, closeDropdown }
 */
export function setupKeyboard(state, actions) {
    window.addEventListener('keydown', (e) => {
        // Don't capture if user is typing in an input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

        switch (e.key) {
            case 't':
            case 'T':
                actions.toggleMode();
                break;
            case ' ':
                e.preventDefault();
                actions.togglePause();
                break;
            case 'r':
            case 'R':
                actions.resetSimulation();
                break;
            case 'g':
            case 'G':
                actions.randomizeSeed();
                break;
            case 'n':
            case 'N':
                actions.generateNewPreset();
                break;
            case 'b':
            case 'B':
                actions.randomizeBehavior();
                break;
            case 'c':
            case 'C':
                actions.saveConfig();
                break;
            case 'v':
            case 'V':
                actions.loadConfig();
                break;
            case 'Escape':
                if (state.dropdownOpen) {
                    actions.closeDropdown(true);
                }
                break;
        }
    });

    window.addEventListener('keyup', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        switch (e.key) {
        }
    });
}

// ─── Mouse ──────────────────────────────────────────────────────────────────

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} state - shared AppState
 * @param {object} actions - callbacks:
 *   { selectParticleAt, performUndo, setTrailDrawState, getConstants }
 */
export function setupMouse(canvas, state, actions) {
    function getCameraUV(clientX, clientY) {
        const cam = state.fancyCamera ? state.camera : null;
        const c = cam ? actions.getConstants() : null;
        return screenToUV(canvas, clientX, clientY, cam, c);
    }

    canvas.addEventListener('mousedown', (e) => {
        if (e.button === 0) {
            if (state.mouseMode === 'select') {
                actions.selectParticleAt(e.clientX, e.clientY);
            } else if (state.mouseMode === 'draw') {
                state.mouseDown = true;
                const uv = getCameraUV(e.clientX, e.clientY);
                state.mousePos = uv;
                state.prevMousePos = { ...uv };
            }
        }
    });

    canvas.addEventListener('mousemove', (e) => {
        if (state.mouseMode === 'draw' && state.mouseDown) {
            state.prevMousePos = { ...state.mousePos };
            state.mousePos = getCameraUV(e.clientX, e.clientY);
        }
    });

    canvas.addEventListener('mouseup', (e) => {
        if (e.button === 0) {
            state.mouseDown = false;
            if (state.mouseMode === 'draw') {
                actions.setTrailDrawState({ x: 0, y: 0, prevX: 0, prevY: 0, radius: 0, power: 0 });
            }
        }
    });

    // Right click = undo
    canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        actions.performUndo();
    });
}

// The view is fixed. The simulation surface is framed to the window and stays
// there: no panning, no zooming, no scroll handler. The camera object still
// exists at its identity values because screenToWorld reads it to map a click
// back to a particle -- it is just never moved.


// Kept as a no-op so the frame loop needs no special-casing; the view is fixed.
export function updateCamera() {}
