/**
 * Particle System Module
 * Manages particle state, simple animation, dissolve/reform cycling, and color overrides.
 */

export class ParticleSystem {
    constructor() {
        this.particles = [];
        // Number of particles that belong to the logo shape (i.e., the ones we retarget on morph).
        this.logoCount = 0;
        this.settings = {
            size: 2.0,
            depthVariance: 0.5,
            animationSpeed: 0.2,
            // Randomization coverage (0..1): fraction of particles affected
            sizeRandom: 1.0,
            opacityRandom: 1.0,
            // Randomization ranges
            // sizeMin/sizeMax are multipliers applied to `size`
            sizeMin: 0.8,
            sizeMax: 1.2,
            opacityMin: 0.68,
            opacityMax: 0.82,
            zoom: 1.0,
            dissolveCycle: true,
            cycleSeconds: 12,
            holdSeconds: 0,
            chaos: 0.75,

            // Shape controls
            squaresEnabled: false,
            // 0..1 (probability of a square instead of a circle)
            squareRatio: 0.25
        };

        this._time = 0;
        this._dissolveAmount = 0;
        this._colorOverride = 'original';
        this._realColors = false;

        // External transition state (used for deterministic logo-to-logo transitions).
        this._transition = {
            active: false,
            morphT: 1,      // 0..1 blend between from-shape and to-shape bases
            scatterT: 0,    // 0..1 how scattered particles are (replaces dissolve in transition mode)
            chaosT: 0,      // 0..1 intensity of turbulence
            attractT: 0,    // 0..1 (reserved for GPU parity / future forces)
            settleT: 0      // 0..1 increases damping / snap
        };

        // Optional per-particle phase profile (staging control for shape-aware transitions).
        this._profile = {
            active: false,
            phaseMode: null,
            phaseParams: null
        };

        // Global density ratio (0..1) for mixed image/logo sequences.
        this._countRatio = 1.0;
        this._countSoftness = 0.08;
    }

    clamp01(v) {
        return Math.max(0, Math.min(1, v));
    }

    ensureRealColor(p) {
        if (!p._realColor) {
            p._realColor = this.pickRealStarColor(p._randSize, p._randOpacity);
        }
        return p._realColor;
    }

    applyDisplayColor(p) {
        if (this._realColors) {
            p.displayColor = this.ensureRealColor(p);
            return;
        }
        const useOverride = this._colorOverride && this._colorOverride !== 'original';
        p.displayColor = useOverride ? this._colorOverride : undefined;
    }

    /**
     * Compute a "halo" base position around the logo, using a specific logo particle as an anchor.
     * This helps ambient particles feel connected to the logo instead of a separate background layer.
     */
    computeHaloBaseFromAnchor(anchor, haloOut, haloTan, haloZ) {
        if (!anchor) return { x: 0, y: 0, z: 0 };

        let dx = anchor.baseX ?? anchor.x ?? 0;
        let dy = anchor.baseY ?? anchor.y ?? 0;
        const ax = anchor.baseX ?? anchor.x ?? 0;
        const ay = anchor.baseY ?? anchor.y ?? 0;
        const az = anchor.baseZ ?? anchor.z ?? 0;

        let mag = Math.hypot(dx, dy);
        if (mag < 1e-4) {
            const a = Math.random() * Math.PI * 2;
            dx = Math.cos(a);
            dy = Math.sin(a);
            mag = 1;
        }
        dx /= mag;
        dy /= mag;

        // Perpendicular (tangent) direction
        const tx = -dy;
        const ty = dx;

        let x = ax + dx * haloOut + tx * haloTan;
        let y = ay + dy * haloOut + ty * haloTan;
        let z = az + haloZ;

        // Keep within clip space so we don't waste particles offscreen.
        const maxAbs = Math.max(Math.abs(x), Math.abs(y));
        if (maxAbs > 0.98) {
            const s = 0.98 / maxAbs;
            x *= s;
            y *= s;
        }
        z = Math.max(-1, Math.min(1, z));

        return { x, y, z };
    }

    /**
     * Recompute ambient particles' halo anchors from the current logo particle bases.
     * Called after morphing so the "background" stays visually tied to the active logo.
     */
    updateAmbientHaloBases() {
        const logoN = Math.max(0, this.logoCount || 0);
        if (!this.particles.length || logoN <= 0) return;

        for (let i = logoN; i < this.particles.length; i++) {
            const p = this.particles[i];
            if (!p || !p._isAmbient) continue;
            // Only halo-anchored ambient particles should be re-anchored on morph.
            // (Starfield/background particles should stay full-canvas and independent.)
            if (p._ambientMode === 0) continue;

            // Ensure anchor + halo params exist
            if (p._anchorIdx == null) p._anchorIdx = Math.floor(Math.random() * logoN);
            p._anchorIdx = Math.max(0, Math.min(logoN - 1, p._anchorIdx | 0));

            if (p._haloOut == null) p._haloOut = 0.05 + Math.random() * 0.25; // outward push
            if (p._haloTan == null) p._haloTan = (Math.random() * 2 - 1) * (0.02 + Math.random() * 0.12); // thickness
            if (p._haloZ == null) p._haloZ = (Math.random() * 2 - 1) * (0.18 + Math.random() * 0.45); // depth

            const anchor = this.particles[p._anchorIdx];
            const base = this.computeHaloBaseFromAnchor(anchor, p._haloOut, p._haloTan, p._haloZ);
            p.baseX = base.x;
            p.baseY = base.y;
            p.baseZ = base.z;
        }
    }

    /**
     * Apply current shape settings (circles vs squares) across particles.
     * Uses each particle's stable `_randShape` so changing the ratio feels consistent.
     */
    applyShapeSettings() {
        if (!this.particles.length) return;

        const enabled = !!this.settings.squaresEnabled;
        const ratio = this.clamp01(Number(this.settings.squareRatio ?? 0));

        for (const p of this.particles) {
            if (!p) continue;
            if (p._randShape == null) p._randShape = Math.random();
            if (p._angle == null) p._angle = (p._randMotion || Math.random()) * Math.PI * 2;

            if (!enabled || ratio <= 0) {
                p._shape = 0;
                p._aspect = 1.0;
                continue;
            }

            p._shape = (p._randShape < ratio) ? 1 : 0;
            // Squares (keep aspect = 1). The shader uses `_angle` for rotation.
            p._aspect = 1.0;
        }
    }

    pickRealStarColor(paletteRand, indexRand) {
        // Apple-ish cool vs warm whites (subtle tint, not saturated).
        // Keep these very close to white: "cool" leans slightly blue, "warm" slightly yellow.
        const cool = ['#f2f8ff', '#e9f3ff', '#deecff', '#d7e8ff'];
        const warm = ['#fff8ea', '#fff2d9', '#ffefc7', '#fff5df'];
        const p = (paletteRand ?? 0) < 0.55 ? cool : warm;
        const idx = Math.max(0, Math.min(p.length - 1, Math.floor((indexRand ?? 0) * p.length)));
        return p[idx];
    }

    /**
     * Initialize particles from sampled points.
     * Points are expected to be normalized into [-1, 1] space.
     */
    initialize(points, { ambientCount = 0 } = {}) {
        this._time = 0;
        this._dissolveAmount = 0;
        this._transition.active = false;
        this._transition.morphT = 1;
        this._transition.scatterT = 0;
        this._transition.chaosT = 0;
        this._transition.attractT = 0;
        this._transition.settleT = 0;
        const pts = points || [];
        this.logoCount = pts.length;
        const useRealColors = !!this._realColors;

	        const logoParticles = pts.map((pt) => {
	            const r1 = Math.random();
	            const r2 = Math.random();
	            const r3 = Math.random();
	            const rSelSize = Math.random();
	            const rSelOpacity = Math.random();

            // Random unit-ish direction for dissolve offset
            const dx = (r1 * 2 - 1);
            const dy = (r2 * 2 - 1);
            const dz = (r3 * 2 - 1);
            const mag = Math.hypot(dx, dy, dz) || 1;
            const ndx = dx / mag;
            const ndy = dy / mag;
            const ndz = dz / mag;

	            const baseOpacity = this.computeBaseOpacity(rSelOpacity, r2);
	            const baseSize = this.computeBaseSize(rSelSize, r1);
            const opacityMul = Number.isFinite(pt.opacityMul) ? pt.opacityMul : 1;
            const sizeMul = Number.isFinite(pt.sizeMul) ? pt.sizeMul : 1;

            const p = {
                // Current position (what renderer reads)
                x: pt.x,
                y: pt.y,
                z: pt.z,

                // Rest/formed position
                baseX: pt.x,
                baseY: pt.y,
                baseZ: pt.z,

                // Morph targets (used only during a transition)
                _morphFromX: null,
                _morphFromY: null,
                _morphFromZ: null,
                _morphToX: null,
                _morphToY: null,
                _morphToZ: null,

                // Far/scattered anchor position (fills the whole canvas when dissolved)
                _scatterX: (Math.random() * 2 - 1),
                _scatterY: (Math.random() * 2 - 1),
                _scatterZ: (Math.random() * 2 - 1),

                // Dissolve offset direction (scaled each update by chaos)
                _dissolveDirX: ndx,
                _dissolveDirY: ndy,
                _dissolveDirZ: ndz,

                // Visuals
                color: pt.color || '#d4d4d8',
                displayColor: undefined,
	                _realColor: this.pickRealStarColor(r1, r2),
	                size: baseSize,
	                _randSize: r1,
	                _randSizeSel: rSelSize,
	                opacity: baseOpacity,
	                _randOpacity: r2,
	                _randOpacitySel: rSelOpacity,
	                _randShape: Math.random(),
	                _sizeMul: sizeMul,
	                _opacityMul: opacityMul,
                _shape: 0, // 0 = circle, 1 = square (when enabled)
                _angle: r3 * Math.PI * 2,
                _aspect: 1.0,

                // Misc
                edge: !!pt.edge,
                _randMotion: r3,
                _isAmbient: false,
                _layer: 0
            };

            if (useRealColors) {
                p.displayColor = p._realColor;
            } else if (this._colorOverride && this._colorOverride !== 'original') {
                p.displayColor = this._colorOverride;
            }

            return p;
        });

        const ambientN = Math.max(0, Number(ambientCount) || 0) | 0;
        const ambientParticles = [];
	        if (ambientN > 0) {
	            for (let i = 0; i < ambientN; i++) {
	                const r1 = Math.random();
	                const r2 = Math.random();
	                const r3 = Math.random();
	                const rSelSize = Math.random();
	                const rSelOpacity = Math.random();
	                const logoN = Math.max(0, this.logoCount || 0);

                // Two ambient modes:
                // - starfield: full-canvas background (never cropped by zoom)
                // - halo: a smaller set of particles anchored around the logo to "connect" the layers
                const haloFraction = 0.28;
                const isHalo = logoN > 0 && Math.random() < haloFraction;

                let x, y, z;
                let scatterX, scatterY, scatterZ;
                let layer = 1; // 1 = background/screen space
                let ambientMode = 0; // 0 = starfield, 1 = halo

                // Halo anchoring params (only for halo particles)
                let anchorIdx = null;
                let haloOut = null;
                let haloTan = null;
                let haloZ = null;

                if (isHalo) {
                    ambientMode = 1;
                    layer = 0; // render in the same zoomed space as the logo

                    anchorIdx = Math.floor(Math.random() * logoN);
                    for (let tries = 0; tries < 6; tries++) {
                        const idx = Math.floor(Math.random() * logoN);
                        const a = logoParticles[idx];
                        if (a && (a.edge || Math.random() < 0.35)) {
                            anchorIdx = idx;
                            break;
                        }
                        anchorIdx = idx;
                    }

                    haloOut = 0.05 + Math.random() * 0.25;
                    haloTan = (Math.random() * 2 - 1) * (0.02 + Math.random() * 0.12);
                    haloZ = (Math.random() * 2 - 1) * (0.18 + Math.random() * 0.45);

                    const anchor = logoParticles[anchorIdx];
                    const haloBase = this.computeHaloBaseFromAnchor(anchor, haloOut, haloTan, haloZ);
                    x = haloBase.x;
                    y = haloBase.y;
                    z = haloBase.z;

                    // Halo particles can still "breathe" out into the full canvas.
                    scatterX = (Math.random() * 2 - 1);
                    scatterY = (Math.random() * 2 - 1);
                    scatterZ = (Math.random() * 2 - 1);
                } else {
                    // True background starfield: always full-canvas, stable and independent of zoom.
                    // Overscan slightly so the cosmos still fills the canvas even under rotation/parallax.
                    const rangeXY = 1.25;
                    x = (Math.random() * 2 - 1) * rangeXY;
                    y = (Math.random() * 2 - 1) * rangeXY;
                    z = (Math.random() * 2 - 1);

                    // Keep the "far" anchor stable so stars don't collapse toward the logo.
                    scatterX = x;
                    scatterY = y;
                    scatterZ = z;
                }

                // Most stars are small; a few are larger "glow" stars.
                const big = r2 > 0.985;
                const sizeMul = big ? 1.6 : (r2 > 0.85 ? 0.95 : 0.7);
                const opacityMul = big ? 0.85 : (r2 > 0.85 ? 0.55 : 0.4);

	                const angle = r3 * Math.PI * 2;
	
	                const p = {
                    x,
                    y,
                    z,

                    baseX: x,
                    baseY: y,
                    baseZ: z,

                    _scatterX: scatterX,
                    _scatterY: scatterY,
                    _scatterZ: scatterZ,

                    // Keep for compatibility (not used for ambient motion right now)
                    _dissolveDirX: (r1 * 2 - 1),
                    _dissolveDirY: (r2 * 2 - 1),
                    _dissolveDirZ: (r3 * 2 - 1),

	                    color: '#d4d4d8',
	                    displayColor: undefined,
	                    _realColor: this.pickRealStarColor(r1, r2),
	                    size: this.computeBaseSize(rSelSize, r1) * sizeMul,
	                    _randSize: r1,
	                    _randSizeSel: rSelSize,
	                    opacity: this.computeBaseOpacity(rSelOpacity, r2) * opacityMul,
	                    _randOpacity: r2,
	                    _randOpacitySel: rSelOpacity,
	                    _randShape: Math.random(),
	                    _sizeMul: sizeMul,
	                    _opacityMul: opacityMul,
                    _shape: 0,
                    _angle: angle,
                    _aspect: 1.0,

                    edge: false,
                    _randMotion: r3,
                    _isAmbient: true,
                    _layer: layer,
                    _ambientMode: ambientMode,

                    // Halo anchoring (only for halo ambient)
                    _anchorIdx: anchorIdx,
                    _haloOut: haloOut,
                    _haloTan: haloTan,
                    _haloZ: haloZ,

                    // How "connected" this particle is when the logo is fully formed.
                    // - Starfield particles should stay in the starfield => 1.0
                    // - Halo particles vary (some stay close, some float out)
                    _ambientMin: (ambientMode === 0)
                        ? 1.0
                        : ((Math.random() < 0.72)
                            ? (0.18 + Math.random() * 0.52) // 0.18..0.70
                            : (0.76 + Math.random() * 0.18)) // 0.76..0.94
                };

                if (useRealColors) {
                    p.displayColor = p._realColor;
                } else if (this._colorOverride && this._colorOverride !== 'original') {
                    p.displayColor = this._colorOverride;
                }

                ambientParticles.push(p);
            }
        }

        this.particles = logoParticles.concat(ambientParticles);
        this.applyShapeSettings();
    }

    /**
     * Provide external transition curves (typically from TransitionDirector).
     * This activates transition mode, overriding the built-in dissolve-cycle curve.
     */
    setTransitionState(state = {}) {
        this._transition.active = true;
        this._transition.morphT = this.clamp01(state.morphT ?? state.t ?? 0);
        this._transition.scatterT = this.clamp01(state.scatterT ?? 0);
        this._transition.chaosT = this.clamp01(state.chaosT ?? 0);
        this._transition.attractT = this.clamp01(state.attractT ?? 0);
        this._transition.settleT = this.clamp01(state.settleT ?? 0);

        if (Number.isFinite(state.countRatio)) {
            this._countRatio = this.clamp01(state.countRatio);
        }
    }

    /**
     * Disable external transition mode and return to built-in dissolve-cycle behavior.
     */
    clearTransitionState() {
        this._transition.active = false;
        this._transition.morphT = 1;
        this._transition.scatterT = 0;
        this._transition.chaosT = 0;
        this._transition.attractT = 0;
        this._transition.settleT = 0;
        this._countRatio = 1.0;
    }

    setCountRatio(ratio, { softness = null } = {}) {
        this._countRatio = this.clamp01(ratio);
        if (Number.isFinite(softness)) {
            this._countSoftness = this.clamp01(softness);
        }
    }

    /**
     * Provide a transition profile used for per-particle staging (edge-first, sdf-front, etc).
     * The caller should set this when starting a transition and clear it when done.
     */
    setTransitionProfile(profile = null) {
        if (!profile) {
            this._profile.active = false;
            this._profile.phaseMode = null;
            this._profile.phaseParams = null;
            return;
        }
        this._profile.active = true;
        this._profile.phaseMode = profile.phaseMode || null;
        this._profile.phaseParams = profile.phaseParams || null;

        // Precompute per-particle `_phase` values for edgeThenFill using stable per-particle randoms.
        if (this._profile.phaseMode === 'edgeThenFill' && this._profile.phaseParams) {
            this.applyEdgeThenFillPhases(this._profile.phaseParams);
        }
        if (this._profile.phaseMode === 'sdfFront' && this._profile.phaseParams) {
            this.applySdfFrontPhases(this._profile.phaseParams);
        }
    }

    clearTransitionProfile() {
        this.setTransitionProfile(null);
    }

    applyEdgeThenFillPhases(params) {
        const n = Math.max(0, this.logoCount || 0);
        if (!this.particles.length || n <= 0) return;

        const edgeStart = clamp01(params.edgeStart ?? 0.05);
        const edgeEnd = clamp01(params.edgeEnd ?? 0.32);
        const fillStart = clamp01(params.fillStart ?? 0.33);
        const fillEnd = clamp01(params.fillEnd ?? 0.88);

        const e0 = Math.min(edgeStart, edgeEnd);
        const e1 = Math.max(edgeStart, edgeEnd);
        const f0 = Math.min(fillStart, fillEnd);
        const f1 = Math.max(fillStart, fillEnd);

        for (let i = 0; i < n; i++) {
            const p = this.particles[i];
            if (!p) continue;
            const r = (p._randMotion != null) ? p._randMotion : Math.random();
            const isEdge = !!p.edge;
            const a = isEdge ? e0 : f0;
            const b = isEdge ? e1 : f1;
            p._phase = a + (b - a) * r;
            p._phaseGroup = isEdge ? 0 : 1;
        }
    }

    applySdfFrontPhases(params) {
        const n = Math.max(0, this.logoCount || 0);
        if (!this.particles.length || n <= 0) return;

        const sdf = params.sdf;
        const w = Math.max(1, params.sdfWidth | 0);
        const h = Math.max(1, params.sdfHeight | 0);
        const norm = params.norm;
        if (!sdf || !norm || sdf.length < w * h) return;

        const scale = Number(norm.scale) || 1;
        const cx = Number(norm.cx) || 0;
        const cy = Number(norm.cy) || 0;
        const invScale = 1.0 / Math.max(1e-8, scale);

        const fillStart = clamp01(params.fillStart ?? 0.10);
        const fillEnd = clamp01(params.fillEnd ?? 0.95);
        const a = Math.min(fillStart, fillEnd);
        const b = Math.max(fillStart, fillEnd);
        const span = b - a;

        const maxInside = Math.max(1e-6, Number(params.maxInside) || 0);
        const power = Math.max(0.25, Number(params.power) || 1.6);

        for (let i = 0; i < n; i++) {
            const p = this.particles[i];
            if (!p) continue;

            const xN = (p._morphToX != null) ? p._morphToX : (p.baseX ?? p.x ?? 0);
            const yN = (p._morphToY != null) ? p._morphToY : (p.baseY ?? p.y ?? 0);

            const xPx = cx + xN * invScale;
            const yPx = cy - yN * invScale;

            let xi = Math.round(xPx);
            let yi = Math.round(yPx);
            if (xi < 0) xi = 0;
            if (yi < 0) yi = 0;
            if (xi > w - 1) xi = w - 1;
            if (yi > h - 1) yi = h - 1;

            const val = sdf[yi * w + xi];
            const d = Math.max(0, val);
            const nd = clamp01(d / maxInside);
            const phase = a + Math.pow(nd, power) * span;

            p._phase = phase;
            p._phaseGroup = 1;
        }
    }

    /**
     * Commit any in-flight morph targets so base positions become the "to" shape.
     * Call this when a transition completes.
     */
    commitMorphTargets() {
        const n = Math.max(0, this.logoCount || 0);
        if (!this.particles.length || n <= 0) return;

        for (let i = 0; i < n; i++) {
            const p = this.particles[i];
            if (!p) continue;
            if (p._morphToX == null) continue;
            p.baseX = p._morphToX;
            p.baseY = p._morphToY;
            p.baseZ = p._morphToZ;
            p._morphFromX = null;
            p._morphFromY = null;
            p._morphFromZ = null;
            p._morphToX = null;
            p._morphToY = null;
            p._morphToZ = null;
        }

        // Re-anchor halo particles to the new bases.
        this.updateAmbientHaloBases();
    }

    getParticles() {
        return this.particles;
    }

    getCount() {
        return this.particles.length;
    }

    /**
     * Update simulation.
     */
    update(deltaTime, externalForces = null) {
        if (!this.particles.length) return;

        const dt = Math.max(0, Math.min(0.05, deltaTime || 0));
        this._time += dt;
        const globalTime = this._time;

        const speed = this.settings.animationSpeed ?? 0.2;
        const depthVariance = this.clamp01(Number(this.settings.depthVariance ?? 0.5));
        const dissolveCycle = !!this.settings.dissolveCycle;
        const cycleSeconds = Math.max(0.1, Number(this.settings.cycleSeconds || 12));
        const holdSeconds = Math.max(0, Number(this.settings.holdSeconds || 0));
        const chaosBase = Math.max(0, Math.min(1, this.settings.chaos ?? 0.75));

        const trActive = !!this._transition.active;
        const morphT = trActive ? this.clamp01(this._transition.morphT) : 1;
        const chaosT = trActive ? this.clamp01(this._transition.chaosT) : 0;
        const settleT = trActive ? this.clamp01(this._transition.settleT) : 0;
        // Effective chaos: keep some baseline life, but allow director to spike it.
        const chaos = this.clamp01(chaosBase * (0.35 + 0.65 * (trActive ? chaosT : 1)));

        // Motion tuning: keep it subtle
        let followBase = Math.max(0.02, Math.min(1, dt * (0.8 + speed * 6)));
        // During settle we want a cleaner snap into place.
        followBase *= (0.65 + 1.35 * settleT);
        followBase = Math.max(0.02, Math.min(1, followBase));

        const wobbleAmpBase = 0.002 + speed * 0.012;
        const wobbleAmp = wobbleAmpBase * (0.75 + 0.9 * chaosT) * (1.0 - 0.45 * settleT);
        const wobbleFreq = 1.0 + speed * 3.5;

        let dissolveAmount = 0;
        if (trActive) {
            // In transition mode, the director drives scatter directly.
            dissolveAmount = this.clamp01(this._transition.scatterT);
        } else if (dissolveCycle) {
            // Hold fully formed, then 0 -> 1 -> 0 smoothly over `cycleSeconds`.
            const totalSeconds = holdSeconds + cycleSeconds;
            const t = (this._time % totalSeconds);
            const local = Math.max(0, t - holdSeconds);
            const phase = Math.min(1, local / cycleSeconds); // 0..1 (0 during hold)
            dissolveAmount = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);

            // During the hold segment, keep dissolve pinned at 0.
            if (t < holdSeconds) dissolveAmount = 0;
        }
        this._dissolveAmount = dissolveAmount;

        // How much we allow particles to wander into the full-canvas "starfield" state.
        // Keep a baseline so even low chaos still has some life.
        const scatterStrength = 0.25 + chaos * 0.75; // 0.25..1
        // Ambient particles should mostly live in the starfield, but be pulled toward a halo
        // around the logo when the logo is formed. This removes the "separate background layer" feel.
        const ambientMinDefault = 0.42 + chaos * 0.22; // 0.42..0.64 (lower = more connected)

        // When Depth Variance is near 0, the logo-anchored ambient halo collapses into a crisp 2D outline
        // that can read like unwanted "edge lines". Fade halo ambient out in that regime.
        const smoothstep = (a, b, x) => {
            const t = this.clamp01((x - a) / Math.max(1e-6, b - a));
            return t * t * (3.0 - 2.0 * t);
        };
        const haloDepthFade = smoothstep(0.08, 0.22, depthVariance);
        // Also add a small amount of stable, per-particle "edge roughness" when Depth Variance is low,
        // so the logo boundary doesn't read like a perfectly clean vector stroke.
        const edgeRoughByDepth = 1.0 - smoothstep(0.12, 0.32, depthVariance);
        // Clip-space jitter amplitude. At depthVariance=0 we want this visibly "fuzzy" (still accurate, not a stroke).
        const edgeJitterAmp = edgeRoughByDepth * (0.006 + 0.007 * chaos);
        // Alpha dithering + partial dropout to break the uniform, continuous outline.
        const edgeAlphaAmount = 0.62 * edgeRoughByDepth;
        const edgeCutAmount = 0.34 * edgeRoughByDepth;
        const edgeDropProb = 0.20 * edgeRoughByDepth;

        const countRatio = this.clamp01(this._countRatio ?? 1.0);
        const countSoft = Math.max(0.02, Math.min(0.25, Number(this._countSoftness ?? 0.08)));

        const profileActive = !!(trActive && this._profile && this._profile.active && this._profile.phaseMode);
        const phaseMode = profileActive ? this._profile.phaseMode : null;
        const phaseParams = profileActive ? (this._profile.phaseParams || {}) : null;
        const phaseWindow = profileActive ? this.clamp01(phaseParams.phaseWindow ?? 0.28) : 0.28;

        // Optional external magnet/repel tool (screen-space circle).
        const magnet = (externalForces && externalForces.magnet && externalForces.magnet.enabled)
            ? externalForces.magnet
            : null;
        const magnetEnabled = !!(magnet &&
            (magnet.radiusClipX > 1e-6) &&
            (magnet.radiusClipY > 1e-6) &&
            (magnet.strength > 1e-6));
        const magnetMode = magnetEnabled && magnet.mode === 'repel' ? 'repel' : 'attract';
        const magnetSign = magnetMode === 'repel' ? 1 : -1;
        const magnetCenterX = magnetEnabled ? (Number(magnet.centerX) || 0) : 0;
        const magnetCenterY = magnetEnabled ? (Number(magnet.centerY) || 0) : 0;
        const magnetRx = magnetEnabled ? (Number(magnet.radiusClipX) || 0) : 0;
        const magnetRy = magnetEnabled ? (Number(magnet.radiusClipY) || 0) : 0;
        const magnetStrength = magnetEnabled ? (Number(magnet.strength) || 0) : 0;
        const magnetZoom = magnetEnabled ? Math.max(0.01, Number(magnet.zoom) || 1.0) : 1.0;
        const magnetDepthScale = magnetEnabled
            ? ((typeof magnet.depthScale === 'number') ? magnet.depthScale : 0.5)
            : 0.5;
        // Strength mapped to a small per-frame displacement in clip space.
        const magnetBase = magnetEnabled ? (magnetStrength * 0.35) : 0;

        // Shared per-frame terms (avoid recomputing per particle)
        const breathe = 0.92 + 0.08 * Math.sin(globalTime * 0.9);
        const sizePulse = 0.98 + 0.02 * Math.cos(globalTime * 0.8);
        const fadeLogo = 1.0 - dissolveAmount * (0.25 + chaos * 0.35);

        for (const p of this.particles) {
            // Ensure older particle objects (from previous versions) still work.
            if (p._scatterX == null) p._scatterX = (Math.random() * 2 - 1);
            if (p._scatterY == null) p._scatterY = (Math.random() * 2 - 1);
            if (p._scatterZ == null) p._scatterZ = (Math.random() * 2 - 1);
            if (p._sizeMul == null) p._sizeMul = 1;
            if (p._opacityMul == null) p._opacityMul = 1;
            if (p._isAmbient == null) p._isAmbient = false;
            if (p._shape == null) p._shape = 0;
            if (p._angle == null) p._angle = (p._randMotion || 0) * Math.PI * 2;
            if (p._aspect == null) p._aspect = 1.0;
            if (p._densityRand == null) p._densityRand = Math.random();

            // Per-particle follow factor (do NOT accumulate across particles).
            let follow = followBase;

            // Gentle noise so it feels alive even when formed
            const t = this._time * wobbleFreq + p._randMotion * 10;
            const wobbleX = Math.sin(t) * wobbleAmp;
            const wobbleY = Math.cos(t * 1.13) * wobbleAmp;
            const wobbleZ = Math.sin(t * 0.77) * (wobbleAmp * 0.7);

            // Formed position (logo) - optionally morph between two bases
            let baseX = p.baseX;
            let baseY = p.baseY;
            let baseZ = p.baseZ;
            if (trActive && p._morphToX != null && p._morphFromX != null) {
                baseX = baseX + (p._morphToX - p._morphFromX) * morphT;
                baseY = baseY + (p._morphToY - p._morphFromY) * morphT;
                baseZ = baseZ + (p._morphToZ - p._morphFromZ) * morphT;
            }

            // Stable logo-space coordinate (formed position, including morph blend; excludes scatter).
            // Used by renderers to apply a logo-wide gradient overlay that doesn't "swim" during dissolve.
            p._logoX = baseX;
            p._logoY = baseY;
            p._logoZ = baseZ;

            let formedX = baseX + wobbleX;
            let formedY = baseY + wobbleY;
            let formedZ = baseZ + wobbleZ;

            if (!p._isAmbient && p.edge && edgeJitterAmp > 1e-7) {
                if (p._edgeJx == null || p._edgeJy == null) {
                    const a = Math.random() * Math.PI * 2;
                    const r = Math.sqrt(Math.random());
                    p._edgeJx = Math.cos(a) * r;
                    p._edgeJy = Math.sin(a) * r;
                }
                if (p._edgeAlpha == null) {
                    // Skew toward dimmer values so some edge points fade out more.
                    const u = Math.random();
                    p._edgeAlpha = 0.25 + 0.75 * (u * u);
                }
                if (p._edgeCut == null) {
                    p._edgeCut = Math.random();
                }
                formedX += p._edgeJx * edgeJitterAmp;
                formedY += p._edgeJy * edgeJitterAmp;
            }

            // Full-canvas scattered position (starfield)
            const farWobbleAmp = wobbleAmp * (0.45 + chaos * 0.55);
            const farX = (formedX + (p._scatterX - formedX) * scatterStrength) + Math.sin(t * 0.73) * farWobbleAmp;
            const farY = (formedY + (p._scatterY - formedY) * scatterStrength) + Math.cos(t * 0.81) * farWobbleAmp;
            const farZ = (formedZ + (p._scatterZ - formedZ) * scatterStrength) + Math.sin(t * 0.57) * (farWobbleAmp * 0.7);

            // Ambient particles should stay in the starfield, regardless of the logo dissolve amount.
            let amt = dissolveAmount;
            if (p._isAmbient) {
                const base = this.clamp01(p._ambientMin == null ? ambientMinDefault : p._ambientMin);
                amt = base + (1.0 - base) * dissolveAmount;
            }

            // Shape-aware phase gating: keep some particles “inactive” (more scattered) until their phase.
            if (phaseMode && !p._isAmbient) {
                const phase = (typeof p._phase === 'number') ? p._phase : 0;
                const win = Math.max(0.02, phaseWindow);
                const localT = this.clamp01((morphT - phase) / win);
                // Blend from fully-scattered (1) toward the global dissolve amount.
                amt = (1.0 - localT) * 1.0 + localT * amt;
                // Also slow positional follow-in until the particle activates.
                follow *= (0.15 + 0.85 * localT);
            }

            const targetX = formedX + (farX - formedX) * amt;
            const targetY = formedY + (farY - formedY) * amt;
            const targetZ = formedZ + (farZ - formedZ) * amt;

            p.x += (targetX - p.x) * follow;
            p.y += (targetY - p.y) * follow;
            p.z += (targetZ - p.z) * follow;

            // Apply MagnetTool as a lightweight screen-space force (logo-space only).
            if (magnetEnabled) {
                const layer = (typeof p._layer === 'number') ? p._layer : (p._isAmbient ? 1 : 0);
                if (layer < 0.5) {
                    // Match the renderer’s depth scaling: posIn.z = a_position.z * u_depthScale.
                    const depth = (Number(p.z) || 0) * magnetDepthScale;
                    const scale = 1.0 - depth * 0.3;
                    const factor = magnetZoom * scale;
                    if (factor > 1e-4) {
                        const clipX = (Number(p.x) || 0) * factor;
                        const clipY = (Number(p.y) || 0) * factor;

                        const dx = clipX - magnetCenterX;
                        const dy = clipY - magnetCenterY;

                        // Normalize into ellipse space so the circle stays round in screen pixels.
                        const dxn = dx / magnetRx;
                        const dyn = dy / magnetRy;
                        const dist2 = dxn * dxn + dyn * dyn;

                        if (dist2 < 1.0) {
                            const dist = Math.sqrt(Math.max(1e-10, dist2));
                            const fall = 1.0 - dist;
                            const falloff = fall * fall;

                            // Direction in ellipse space -> back into clip space.
                            const invDist = 1.0 / dist;
                            const dirEllX = dxn * invDist;
                            const dirEllY = dyn * invDist;
                            const dirClipX = dirEllX * magnetRx;
                            const dirClipY = dirEllY * magnetRy;

                            const dClip = magnetBase * falloff * dt * magnetSign;
                            const dSim = dClip / factor;

                            p.x += dirClipX * dSim;
                            p.y += dirClipY * dSim;

                            // Safety bounds (match GPU sim’s soft bounds range).
                            p.x = Math.max(-1.35, Math.min(1.35, p.x));
                            p.y = Math.max(-1.35, Math.min(1.35, p.y));
                        }
                    }
                }
            }

		            // Opacity gently breathes; also fades a bit when fully dissolved
		            const selOpacity = (p._randOpacitySel == null) ? p._randOpacity : p._randOpacitySel;
		            const baseOpacity = this.computeBaseOpacity(selOpacity, p._randOpacity) * (p._opacityMul || 1);
            let countFade = 1.0;
            if (!p._isAmbient && countRatio < 0.999) {
                const edge = Math.min(1.0, countRatio + countSoft);
                const tCount = smoothstep(countRatio, edge, p._densityRand);
                countFade = 1.0 - tCount;
            }
            const fade = p._isAmbient ? 1.0 : (fadeLogo * countFade);
            const twinkle = p._isAmbient ? (0.82 + 0.18 * Math.sin(t * 0.55 + p._randSize * 10)) : 1.0;
            const haloFade = (p._isAmbient && p._ambientMode === 1) ? haloDepthFade : 1.0;
            const edgeCutMul = (!p._isAmbient && p.edge && edgeCutAmount > 1e-7)
                ? (((p._edgeCut ?? 1.0) < edgeDropProb)
                    ? 0.0
                    : smoothstep(edgeDropProb, edgeCutAmount, (p._edgeCut ?? 1.0)))
                : 1.0;
            const edgeAlphaMul = (!p._isAmbient && p.edge && edgeAlphaAmount > 1e-7)
                ? ((1.0 - edgeAlphaAmount) + edgeAlphaAmount * (p._edgeAlpha ?? 1.0))
                : 1.0;
            const minAlpha = (p._isAmbient && p._ambientMode === 1) ? 0.0 : 0.02;
            const edgeMinAlpha = (!p._isAmbient && p.edge && edgeCutAmount > 1e-7) ? 0.0 : minAlpha;
            const minAlphaScaled = minAlpha * countFade;
            const edgeMinAlphaScaled = edgeMinAlpha * countFade;
            p.opacity = Math.max(
                edgeMinAlphaScaled,
                Math.min(1, baseOpacity * breathe * fade * twinkle * haloFade * edgeAlphaMul * edgeCutMul)
            );

		            // Size stays mostly stable; a tiny pulse is fine
		            const selSize = (p._randSizeSel == null) ? p._randSize : p._randSizeSel;
		            const baseSize = this.computeBaseSize(selSize, p._randSize) * (p._sizeMul || 1);
		            p.size = Math.max(0.15, baseSize * sizePulse);
		        }
		    }

    /**
     * Current dissolve amount (0..1). Useful for syncing external events (like morphing) to the dissolve peak.
     */
    getDissolveAmount() {
        return this._dissolveAmount || 0;
    }

    /**
     * Morph the "formed" shape to a new set of points, without recreating particles.
     * The caller should ensure `points.length === logoCount` for best results.
     */
    morphTo(points, { updateColor = true } = {}) {
        if (!points || !points.length) return;
        if (!this.particles.length) {
            this.initialize(points);
            return;
        }

        const count = Math.max(0, this.logoCount || 0);
        const n = Math.min(count, points.length);

        for (let i = 0; i < n; i++) {
            const p = this.particles[i];
            const pt = points[i];

            // Capture current base as morph-from, and set morph-to to the new target.
            p._morphFromX = p.baseX;
            p._morphFromY = p.baseY;
            p._morphFromZ = p.baseZ;
            p._morphToX = pt.x;
            p._morphToY = pt.y;
            p._morphToZ = pt.z;

            p.edge = !!pt.edge;

            if (updateColor && pt.color) {
                p.color = pt.color;
                this.applyDisplayColor(p);
            }
            if (Number.isFinite(pt.opacityMul)) p._opacityMul = pt.opacityMul;
            if (Number.isFinite(pt.sizeMul)) p._sizeMul = pt.sizeMul;
        }

        // If the new point cloud has fewer points than particles, park extra particles at random targets.
        // (Normally avoided by pre-normalizing counts in the app.)
        for (let i = n; i < count; i++) {
            const p = this.particles[i];
            const fallback = points[Math.floor(Math.random() * points.length)];
            p._morphFromX = p.baseX;
            p._morphFromY = p.baseY;
            p._morphFromZ = p.baseZ;
            p._morphToX = fallback.x;
            p._morphToY = fallback.y;
            p._morphToZ = fallback.z;
            p.edge = !!fallback.edge;
            if (updateColor && fallback.color) {
                p.color = fallback.color;
                this.applyDisplayColor(p);
            }
            if (Number.isFinite(fallback.opacityMul)) p._opacityMul = fallback.opacityMul;
            if (Number.isFinite(fallback.sizeMul)) p._sizeMul = fallback.sizeMul;
        }

        // Note: halo re-anchoring is deferred until morph commit so we don't abruptly snap.
    }

    /**
     * Push particles away from their base positions so the next frames "reform" them back into the shape.
     * This is used to make the first logo "appear" from scattered particles.
     */
    scatter(amount = 1.0) {
        if (!this.particles.length) return;

        const a = Math.max(0, Math.min(1.5, amount));
        const chaos = Math.max(0, Math.min(1, this.settings.chaos ?? 0.75));
        const scatterStrength = 0.25 + chaos * 0.75;
        const jitter = 0.02 + chaos * 0.08;

        for (const p of this.particles) {
            // Keep the background cosmos stable; only scatter logo-space particles.
            const layer = (typeof p._layer === 'number') ? p._layer : (p._isAmbient ? 1 : 0);
            if (layer >= 0.5) continue;

            if (p._scatterX == null) p._scatterX = (Math.random() * 2 - 1);
            if (p._scatterY == null) p._scatterY = (Math.random() * 2 - 1);
            if (p._scatterZ == null) p._scatterZ = (Math.random() * 2 - 1);

            const formedX = p.baseX;
            const formedY = p.baseY;
            const formedZ = p.baseZ;

            const farX = formedX + (p._scatterX - formedX) * scatterStrength;
            const farY = formedY + (p._scatterY - formedY) * scatterStrength;
            const farZ = formedZ + (p._scatterZ - formedZ) * scatterStrength;

            // Move towards the far position; allow mild overshoot with a>1 for a punchier scatter.
            p.x = formedX + (farX - formedX) * a + (Math.random() - 0.5) * jitter;
            p.y = formedY + (farY - formedY) * a + (Math.random() - 0.5) * jitter;
            p.z = formedZ + (farZ - formedZ) * a + (Math.random() - 0.5) * jitter;
        }
    }

    /**
     * Merge new settings and re-derive per-particle size/opacity where relevant.
     */
    updateSettings(next) {
        const incoming = next || {};
        this.settings = { ...this.settings, ...incoming };

	        // Recompute size/opacity only when relevant settings change.
	        // (Depth variance, animation speed, etc. shouldn't trigger an O(n) loop.)
	        const shouldRecomputeVisuals =
	            Object.prototype.hasOwnProperty.call(incoming, 'size') ||
	            Object.prototype.hasOwnProperty.call(incoming, 'sizeRandom') ||
	            Object.prototype.hasOwnProperty.call(incoming, 'sizeMin') ||
	            Object.prototype.hasOwnProperty.call(incoming, 'sizeMax') ||
	            Object.prototype.hasOwnProperty.call(incoming, 'opacityRandom') ||
	            Object.prototype.hasOwnProperty.call(incoming, 'opacityMin') ||
	            Object.prototype.hasOwnProperty.call(incoming, 'opacityMax');

	        if (shouldRecomputeVisuals) {
	            for (const p of this.particles) {
	                const opacityMul = p._opacityMul == null ? 1 : p._opacityMul;
	                const sizeMul = p._sizeMul == null ? 1 : p._sizeMul;
	                const selOpacity = (p._randOpacitySel == null) ? p._randOpacity : p._randOpacitySel;
	                const selSize = (p._randSizeSel == null) ? p._randSize : p._randSizeSel;
	                p.opacity = Math.max(
	                    0.02,
	                    Math.min(1, this.computeBaseOpacity(selOpacity, p._randOpacity) * opacityMul)
	                );
	                p.size = Math.max(0.15, this.computeBaseSize(selSize, p._randSize) * sizeMul);
	            }
	        }

        const shouldRecomputeShapes =
            Object.prototype.hasOwnProperty.call(incoming, 'squaresEnabled') ||
            Object.prototype.hasOwnProperty.call(incoming, 'squareRatio');
        if (shouldRecomputeShapes) {
            this.applyShapeSettings();
        }
    }

    /**
     * Color override, used by the renderer via `displayColor`.
     */
    setColorOverride(color) {
        this._colorOverride = color || 'original';
        if (this._realColors) return;
        const useOverride = this._colorOverride !== 'original';

        for (const p of this.particles) {
            p.displayColor = useOverride ? this._colorOverride : undefined;
        }
    }

    /**
     * Toggle Apple-like "real" star colors (cool/warm whites).
     * When enabled, we override each particle's `displayColor` with a stable per-particle palette color.
     */
    setRealColors(enabled) {
        this._realColors = !!enabled;

        for (const p of this.particles) {
            this.ensureRealColor(p);
            this.applyDisplayColor(p);
        }
    }

	    computeBaseSize(selectRand, valueRand) {
	        const base = Number(this.settings.size ?? 2.0);
	        const coverage = clamp01(this.settings.sizeRandom ?? 0);
	        if (!(coverage > 0) || !(Number(selectRand) < coverage)) {
	            return Math.max(0.2, base);
	        }

	        const minIn = Number(this.settings.sizeMin ?? 0.8);
	        const maxIn = Number(this.settings.sizeMax ?? 1.2);
	        const min = Math.max(0.05, Math.min(minIn, maxIn));
	        const max = Math.max(0.05, Math.max(minIn, maxIn));
	        const t = clamp01(valueRand);
	        const mul = min + (max - min) * t;
	        return Math.max(0.2, base * mul);
	    }

	    computeBaseOpacity(selectRand, valueRand) {
	        const base = 0.75;
	        const coverage = clamp01(this.settings.opacityRandom ?? 0);
	        if (!(coverage > 0) || !(Number(selectRand) < coverage)) {
	            return Math.max(0.08, Math.min(1, base));
	        }

	        const minIn = Number(this.settings.opacityMin ?? base);
	        const maxIn = Number(this.settings.opacityMax ?? base);
	        const min = Math.max(0, Math.min(minIn, maxIn));
	        const max = Math.max(0, Math.max(minIn, maxIn));
	        const t = clamp01(valueRand);
	        const out = min + (max - min) * t;
	        return Math.max(0.08, Math.min(1, out));
	    }
	}

function clamp01(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}
