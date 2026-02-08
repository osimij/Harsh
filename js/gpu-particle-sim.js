/**
 * gpu-particle-sim.js
 * WebGL2 GPU particle simulation using ping-pong float textures.
 *
 * Notes:
 * - Designed for offline/high-quality rendering (200k–2M particles).
 * - Requires WebGL2 + EXT_color_buffer_float.
 */
import {
    createProgram,
    createTexture2D,
    createFramebuffer,
    bindFramebufferWithAttachments,
    assertFramebufferComplete,
    ensureColorBufferFloat,
    createFullscreenTriangle,
    safeDelete
} from './gl-utils.js';

export class GPUParticleSim {
    constructor(gl, { count = 200000, seed = 1 } = {}) {
        this.gl = gl;
        this.count = Math.max(1, count | 0);
        this.time = 0;
        this.seed = hash32(String(seed ?? 1));

        this.supported = !!gl && !!gl.createTexture && ensureColorBufferFloat(gl);
        if (!this.supported) {
            throw new Error('GPUParticleSim requires WebGL2 + EXT_color_buffer_float');
        }

        // Texture dimensions for particle state
        const w = Math.ceil(Math.sqrt(this.count));
        const h = Math.ceil(this.count / w);
        this.texWidth = w;
        this.texHeight = h;
        this.capacity = w * h;

        // Ping-pong indices
        this._idx = 0;

        // GL resources
        this._vao = null;
        this._vbo = null;
        this._program = null;
        this._fbos = [null, null];
        this._posTex = [null, null];
        this._velTex = [null, null];
        this._randTex = null;

        // Target textures (external ownership allowed)
        this._targetFrom = null;
        this._targetTo = null;
        // Low-res vector field texture derived from the "to" logo (external ownership allowed)
        this._toFieldTex = null;
        // 1x1 neutral field texture (internal)
        this._defaultFieldTex = null;

        // Cached uniform locations
        this._u = null;

        this._initGLResources();
        this._initRandomTexture();
        this._initDefaultFieldTexture();
        this.reset();
    }

    _initGLResources() {
        const gl = this.gl;

        const vs = `#version 300 es
            layout(location=0) in vec2 a_position;
            void main() {
                gl_Position = vec4(a_position, 0.0, 1.0);
            }
        `;

        const fs = `#version 300 es
            precision highp float;
            precision highp sampler2D;

            uniform sampler2D u_posTex;
            uniform sampler2D u_velTex;
            uniform sampler2D u_randTex;
            uniform sampler2D u_targetFrom;
            uniform sampler2D u_targetTo;
            uniform sampler2D u_toFieldTex;

            uniform vec2 u_texSize;
            uniform int u_count;
            uniform float u_dt;
            uniform float u_time;

            // Timeline curves (0..1)
            uniform float u_morphT;
            uniform float u_scatterT;
            uniform float u_chaosT;
            uniform float u_attractT;
            uniform float u_settleT;

            // Script extras (0..1 unless noted)
            uniform float u_orbitT;
            // Signed [-1,1]: + = burst outward, - = collapse inward.
            uniform float u_burstT;
            uniform float u_nextFieldT;

            // Orbit params (used when u_orbitT > 0)
            uniform vec2 u_orbitCenter;
            uniform float u_orbitRadius;
            uniform float u_orbitOmega;
            uniform float u_orbitGain;
            uniform float u_orbitRingK;

            // Burst params (used when abs(u_burstT) > 0)
            uniform vec2 u_burstCenter;
            uniform float u_burstStrength;

            // Next-logo field params
            uniform float u_nextFieldStrength;

            // Field params
            uniform vec2 u_noiseOffset;
            uniform float u_noiseScale;
            uniform float u_noiseStrength;
            uniform float u_noiseSpeed;

            // Vortex params (up to 3 centers)
            uniform vec2 u_vortex1;
            uniform vec2 u_vortex2;
            uniform vec2 u_vortex3;
            uniform float u_vortexStrength;
            uniform float u_vortexRadius;

	            // Shape forces
	            uniform float u_repulseStrength;
	            uniform float u_attractStrength;
	            uniform float u_drag;
	            uniform float u_maxSpeed;
	
	            // MagnetTool (screen-space circle) params (clip space, y up)
	            uniform float u_magnetEnabled;    // 0/1
	            uniform vec2 u_magnetCenter;      // clip space [-1,1]
	            uniform vec2 u_magnetRadius;      // clip radii (ellipse to stay round in pixels)
	            uniform float u_magnetStrength;   // unitless (mapped to small displacement)
	            uniform float u_magnetSign;       // -1 attract, +1 repel
	            uniform float u_magnetZoom;       // matches renderer zoom
	            uniform float u_magnetDepthScale; // matches depthVariance

	            layout(location=0) out vec4 out_pos;
	            layout(location=1) out vec4 out_vel;

            float hash21(vec2 p) {
                // Cheap 2D hash -> 0..1
                vec3 p3 = fract(vec3(p.xyx) * 0.1031);
                p3 += dot(p3, p3.yzx + 33.33);
                return fract((p3.x + p3.y) * p3.z);
            }

            float noise2(vec2 p) {
                vec2 i = floor(p);
                vec2 f = fract(p);
                float a = hash21(i);
                float b = hash21(i + vec2(1.0, 0.0));
                float c = hash21(i + vec2(0.0, 1.0));
                float d = hash21(i + vec2(1.0, 1.0));
                vec2 u = f * f * (3.0 - 2.0 * f);
                return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
            }

            vec2 curl2(vec2 p) {
                // Divergence-free 2D field from scalar noise potential
                float e = 0.35;
                float n1 = noise2(p + vec2(0.0, e));
                float n2 = noise2(p - vec2(0.0, e));
                float n3 = noise2(p + vec2(e, 0.0));
                float n4 = noise2(p - vec2(e, 0.0));
                float dndy = (n1 - n2) / (2.0 * e);
                float dndx = (n3 - n4) / (2.0 * e);
                return vec2(dndy, -dndx);
            }

            vec2 vortex(vec2 pos, vec2 center, float strength, float radius) {
                vec2 r = pos - center;
                float d = length(r) + 1e-4;
                vec2 tang = vec2(-r.y, r.x) / d;
                float falloff = exp(-(d * d) / (radius * radius));
                return tang * (strength * falloff);
            }

            vec2 orbitForce(vec2 pos, vec2 vel, vec2 center, float radius, float omega, float gain, float ringK) {
                vec2 r = pos - center;
                float d = length(r) + 1e-4;
                vec2 n = r / d;
                vec2 tang = vec2(-n.y, n.x);

                // Desired tangential velocity for ~N loops (omega derived in JS per duration).
                vec2 desiredVel = tang * (omega * radius);
                vec2 steer = (desiredVel - vel) * gain;

                // Radial spring to keep a readable ring.
                float err = radius - d;
                vec2 ring = n * (err * ringK);

                return steer + ring;
            }

            void main() {
                ivec2 coord = ivec2(gl_FragCoord.xy);
                // Only valid texels correspond to particle ids. Padding texels remain stable.
                int id = coord.y * int(u_texSize.x) + coord.x;

                vec4 pos4 = texelFetch(u_posTex, coord, 0);
                vec4 vel4 = texelFetch(u_velTex, coord, 0);
                vec4 rnd4 = texelFetch(u_randTex, coord, 0);

                vec3 pos = pos4.xyz;
                vec3 vel = vel4.xyz;

                // If this is padding beyond count, just keep it inert
                if (id >= u_count) { out_pos = pos4; out_vel = vel4; return; }

                // Fetch targets (packed per-particle)
                vec3 fromT = texelFetch(u_targetFrom, coord, 0).xyz;
                vec3 toT = texelFetch(u_targetTo, coord, 0).xyz;

                // As we "settle" into the final logo, fade out all chaotic forces and
                // progressively lock particles to their exact target positions.
                // The lock starts earlier and ramps more gently so the transition feels smooth
                // across the full duration (less "magnetic snap" at the end).
                float settle = clamp(u_settleT, 0.0, 1.0);
                // Fade out chaos during the settle phase. Use a wide curve so we don't "snap".
                float lockFade = smoothstep(0.35, 1.0, settle);

                // Noise-driven advection (swirl)
                vec2 np = pos.xy * u_noiseScale + u_noiseOffset + u_time * u_noiseSpeed;
                vec2 c = curl2(np);
                vec2 adv = c * u_noiseStrength * (0.15 + 0.85 * u_chaosT) * (1.0 - lockFade);

                // Vortex centers add stronger coherent motion
                vec2 v = vec2(0.0);
                float vs = u_vortexStrength * (0.15 + 0.85 * u_chaosT) * (1.0 - lockFade);
                float vr = u_vortexRadius;
                v += vortex(pos.xy, u_vortex1, vs, vr);
                v += vortex(pos.xy, u_vortex2, vs * 0.8, vr * 1.1);
                v += vortex(pos.xy, u_vortex3, vs * 0.6, vr * 0.9);

                // Shape forces:
                // - Attract toward the current target shape (toT) during reform / transitions
                // - Scatter uses a stable per-particle scatter target derived from the random texture.
                //   This avoids the "boxy rectangle" artifact you get from repulsion + hard axis bounds.
                const float TWO_PI = 6.28318530718;

                float ang = rnd4.x * TWO_PI;
                // Slight center bias (more organic than a perfectly uniform disk)
                float r = pow(rnd4.y, 0.65);
                float radius = 1.25;
                vec2 scatterXY = vec2(cos(ang), sin(ang)) * (r * radius);
                float scatterZ = (rnd4.z * 2.0 - 1.0) * 1.05;
                vec3 scatterTgt = vec3(scatterXY, scatterZ);

                vec3 scatterDelta = scatterTgt - pos;
                vec3 scatter = scatterDelta * (u_repulseStrength * u_scatterT);

                vec3 toDelta = (toT - pos);
                vec3 attract = toDelta * (u_attractStrength * u_attractT);

                // Orbit script: a readable ring + 1–2 laps before we fully commit to the target.
                vec2 orb = vec2(0.0);
                if (u_orbitT > 1e-4) {
                    orb = orbitForce(pos.xy, vel.xy, u_orbitCenter, u_orbitRadius, u_orbitOmega, u_orbitGain, u_orbitRingK) * u_orbitT * (1.0 - lockFade);
                }

                // Fireball burst: outward impulse, then collapse back inward before final attraction.
                vec2 burst = vec2(0.0);
                float bt = u_burstT;
                if (abs(bt) > 1e-4) {
                    vec2 r = pos.xy - u_burstCenter;
                    float d = length(r) + 1e-4;
                    vec2 dir = r / d;
                    // Soft falloff keeps the effect punchy near center but stable at edges.
                    float fall = exp(-(d * d) / 0.55);
                    burst = dir * (u_burstStrength * bt * fall) * (1.0 - lockFade);
                }

                // Next-logo-driven field: a low-res flow derived from the next logo's point density.
                vec2 nextField = vec2(0.0);
                if (u_nextFieldT > 1e-4 && u_nextFieldStrength > 1e-4) {
                    // pos.xy is already roughly in clip space; map [-1,1] to [0,1] and clamp.
                    vec2 uvRaw = pos.xy * 0.5 + 0.5;
                    vec2 uv = clamp(uvRaw, 0.0, 1.0);
                    // When particles wander outside the field domain, clamping makes many of them
                    // sample the same edge texel and can create visible "ceiling" pile-ups.
                    // Fade the field out smoothly once we're outside to keep motion organic.
                    float outside = length(uvRaw - uv); // 0 inside, >0 outside
                    float fieldFade = 1.0 - smoothstep(0.0, 0.12, outside);
                    vec4 ft = texture(u_toFieldTex, uv);
                    vec2 dir = ft.xy * 2.0 - 1.0;
                    float mag = ft.z; // 0..1
                    nextField = dir * (mag * u_nextFieldStrength * u_nextFieldT * fieldFade) * (1.0 - lockFade);
                }

                // Small z turbulence so it feels volumetric (still anchored by target z)
                float zNoise = noise2(np + vec2(rnd4.z * 31.7, rnd4.w * 19.3));
                float zKick = (zNoise - 0.5) * (0.35 + 0.65 * u_chaosT) * (1.0 - lockFade);

                vec3 acc = vec3(adv + v + orb + burst + nextField, zKick) + scatter + attract;

                // Soft bounds: gently push particles back inward near the sim limits so we don't
                // visibly "stack" on a hard boundary during high-chaos transitions.
                float bound = 1.35;

                // XY soft wall starts very close to the hard bound (won't fight scatter targets).
                float softXY = bound - mix(0.12, 0.05, clamp(u_scatterT, 0.0, 1.0));
                float r0 = length(pos.xy);
                if (r0 > softXY) {
                    vec2 n0 = pos.xy / max(r0, 1e-6);
                    float tw = clamp((r0 - softXY) / max(1e-6, bound - softXY), 0.0, 1.0);
                    float kWall = mix(0.0, 10.0, tw * tw) * (0.25 + 0.75 * u_chaosT);
                    acc.xy -= n0 * (kWall * (1.0 - lockFade));
                }

                // Z soft wall (prevents planar "ceiling" artifacts when view is tilted).
                float softZ = bound - 0.06;
                float az0 = abs(pos.z);
                if (az0 > softZ) {
                    float twz = clamp((az0 - softZ) / max(1e-6, bound - softZ), 0.0, 1.0);
                    float kWallZ = mix(0.0, 10.0, twz * twz) * (0.25 + 0.75 * u_chaosT);
                    acc.z -= sign(pos.z) * (kWallZ * (1.0 - lockFade));
                }

                // Integrate
                vel += acc * u_dt;
                // Drag ramps up during settle so particles snap cleanly
                float drag = u_drag + u_settleT * (u_drag * 2.5);
                vel *= max(0.0, 1.0 - drag * u_dt);

                // Clamp speed
                float sp = length(vel);
                if (sp > u_maxSpeed) {
                    vel *= (u_maxSpeed / max(sp, 1e-6));
                }

                pos += vel * u_dt;

                // Hard bounds (rare with soft walls above):
                // - Radial bounds in XY (prevents square/rectangle silhouettes)
                // - Clamp in Z
                float rxy = length(pos.xy);
                if (rxy > bound) {
                    vec2 n = pos.xy / max(rxy, 1e-6);
                    // Per-particle radius jitter breaks up the visible ring/line when many particles hit the wall.
                    float fuzz = (rnd4.w - 0.5) * 0.06;
                    float b = clamp(bound - 0.02 + fuzz, bound - 0.08, bound);
                    pos.xy = n * b;

                    // Reflect outward velocity with some damping so particles bounce back in,
                    // rather than "parking" on the boundary.
                    float vn = dot(vel.xy, n);
                    if (vn > 0.0) {
                        // restitution ~= 0.6  ->  subtract (1+e)*vn
                        vel.xy -= n * (vn * 1.6);
                    }
                    vel.xy *= 0.85;
	                }
	                float az = abs(pos.z);
	                if (az > bound) {
                        float nz = sign(pos.z);
                        float fuzzZ = (rnd4.y - 0.5) * 0.06;
                        float bz = clamp(bound - 0.02 + fuzzZ, bound - 0.08, bound);
                        pos.z = nz * bz;
                        float vnz = vel.z * nz;
                        if (vnz > 0.0) {
                            vel.z -= nz * (vnz * 1.6);
                        }
                        vel.z *= 0.85;
                    }
	
	                // MagnetTool: apply a small screen-space displacement inside the circle/ellipse.
	                // Mirrors the CPU magnet math so it feels the same in GPU mode.
	                if (u_magnetEnabled > 0.5) {
	                    float depth = pos.z * u_magnetDepthScale;
	                    float scale = 1.0 - depth * 0.3;
	                    float factor = max(1e-4, u_magnetZoom * scale);
	
	                    vec2 clipPos = pos.xy * factor;
	                    vec2 d = clipPos - u_magnetCenter;
	
	                    // Normalize into ellipse space so the circle stays round in pixels.
	                    vec2 r = max(vec2(1e-6), u_magnetRadius);
	                    vec2 dn = d / r;
	                    float dist2 = dot(dn, dn);
	                    if (dist2 < 1.0) {
	                        float dist = sqrt(max(1e-10, dist2));
	                        float fall = 1.0 - dist;
	                        float falloff = fall * fall;
	
	                        // Direction in ellipse space -> back into clip space.
	                        vec2 dirEll = dn / dist;
	                        vec2 dirClip = dirEll * r;
	
	                        float base = u_magnetStrength * 0.35;
	                        float dClip = base * falloff * u_dt * u_magnetSign;
	                        float dSim = dClip / factor;
	
	                        pos.xy += dirClip * dSim;
	
	                        // Keep within the sim's soft bounds
	                        float rr = length(pos.xy);
	                        if (rr > bound) {
	                            pos.xy = (pos.xy / max(rr, 1e-6)) * bound;
	                        }
	                    }
	                }

	                // Final converge: smoothly (dt-based) pull positions onto the target without a visible snap.
	                // This preserves a clean final logo while keeping the animation continuous.
	                if (lockFade > 1e-6) {
                    // alpha = 1 - exp(-k * lockFade * dt)  -> framerate-independent smoothing
                    // To avoid a "magnetic snap" near the end, soften the lock when already close.
                    float k = mix(2.5, 9.0, lockFade);
                    float alpha = 1.0 - exp(-k * lockFade * u_dt);

                    // When distance-to-target is tiny, reduce the lock gain so it eases in gently.
                    float d = length(toT - pos);
                    float nearT = smoothstep(0.0, 0.10, d); // 0 when very close, 1 when >= ~0.10
                    float soften = 0.25 + 0.75 * nearT;     // keep some pull even when close
                    alpha *= soften;

                    pos = mix(pos, toT, alpha);
                    vel *= (1.0 - alpha);
                }

                out_pos = vec4(pos, pos4.w);
                out_vel = vec4(vel, vel4.w);
            }
        `;
        this._program = createProgram(gl, vs, fs);

        // Fullscreen draw geometry
        const tri = createFullscreenTriangle(gl);
        this._vao = tri.vao;
        this._vbo = tri.vbo;

        // Create ping-pong textures + fbos
        for (let i = 0; i < 2; i++) {
            this._posTex[i] = createTexture2D(gl, {
                width: this.texWidth,
                height: this.texHeight,
                internalFormat: gl.RGBA32F,
                format: gl.RGBA,
                type: gl.FLOAT,
                data: null
            });

            this._velTex[i] = createTexture2D(gl, {
                width: this.texWidth,
                height: this.texHeight,
                internalFormat: gl.RGBA32F,
                format: gl.RGBA,
                type: gl.FLOAT,
                data: null
            });

            this._fbos[i] = createFramebuffer(gl);
            bindFramebufferWithAttachments(gl, this._fbos[i], [
                { attachment: gl.COLOR_ATTACHMENT0, texture: this._posTex[i] },
                { attachment: gl.COLOR_ATTACHMENT1, texture: this._velTex[i] }
            ]);
            gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
            assertFramebufferComplete(gl, `gpu-sim-fbo-${i}`);
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.useProgram(this._program);

	        this._u = {
            posTex: gl.getUniformLocation(this._program, 'u_posTex'),
            velTex: gl.getUniformLocation(this._program, 'u_velTex'),
            randTex: gl.getUniformLocation(this._program, 'u_randTex'),
            targetFrom: gl.getUniformLocation(this._program, 'u_targetFrom'),
            targetTo: gl.getUniformLocation(this._program, 'u_targetTo'),
            toFieldTex: gl.getUniformLocation(this._program, 'u_toFieldTex'),
            texSize: gl.getUniformLocation(this._program, 'u_texSize'),
            count: gl.getUniformLocation(this._program, 'u_count'),
            dt: gl.getUniformLocation(this._program, 'u_dt'),
            time: gl.getUniformLocation(this._program, 'u_time'),
            morphT: gl.getUniformLocation(this._program, 'u_morphT'),
            scatterT: gl.getUniformLocation(this._program, 'u_scatterT'),
            chaosT: gl.getUniformLocation(this._program, 'u_chaosT'),
            attractT: gl.getUniformLocation(this._program, 'u_attractT'),
            settleT: gl.getUniformLocation(this._program, 'u_settleT'),
            orbitT: gl.getUniformLocation(this._program, 'u_orbitT'),
            burstT: gl.getUniformLocation(this._program, 'u_burstT'),
            nextFieldT: gl.getUniformLocation(this._program, 'u_nextFieldT'),
            orbitCenter: gl.getUniformLocation(this._program, 'u_orbitCenter'),
            orbitRadius: gl.getUniformLocation(this._program, 'u_orbitRadius'),
            orbitOmega: gl.getUniformLocation(this._program, 'u_orbitOmega'),
            orbitGain: gl.getUniformLocation(this._program, 'u_orbitGain'),
            orbitRingK: gl.getUniformLocation(this._program, 'u_orbitRingK'),
            burstCenter: gl.getUniformLocation(this._program, 'u_burstCenter'),
            burstStrength: gl.getUniformLocation(this._program, 'u_burstStrength'),
            nextFieldStrength: gl.getUniformLocation(this._program, 'u_nextFieldStrength'),
            noiseOffset: gl.getUniformLocation(this._program, 'u_noiseOffset'),
            noiseScale: gl.getUniformLocation(this._program, 'u_noiseScale'),
            noiseStrength: gl.getUniformLocation(this._program, 'u_noiseStrength'),
            noiseSpeed: gl.getUniformLocation(this._program, 'u_noiseSpeed'),
            vortex1: gl.getUniformLocation(this._program, 'u_vortex1'),
            vortex2: gl.getUniformLocation(this._program, 'u_vortex2'),
            vortex3: gl.getUniformLocation(this._program, 'u_vortex3'),
            vortexStrength: gl.getUniformLocation(this._program, 'u_vortexStrength'),
            vortexRadius: gl.getUniformLocation(this._program, 'u_vortexRadius'),
	            repulseStrength: gl.getUniformLocation(this._program, 'u_repulseStrength'),
	            attractStrength: gl.getUniformLocation(this._program, 'u_attractStrength'),
	            drag: gl.getUniformLocation(this._program, 'u_drag'),
	            maxSpeed: gl.getUniformLocation(this._program, 'u_maxSpeed'),
	
	            // MagnetTool (GPU mode)
	            magnetEnabled: gl.getUniformLocation(this._program, 'u_magnetEnabled'),
	            magnetCenter: gl.getUniformLocation(this._program, 'u_magnetCenter'),
	            magnetRadius: gl.getUniformLocation(this._program, 'u_magnetRadius'),
	            magnetStrength: gl.getUniformLocation(this._program, 'u_magnetStrength'),
	            magnetSign: gl.getUniformLocation(this._program, 'u_magnetSign'),
	            magnetZoom: gl.getUniformLocation(this._program, 'u_magnetZoom'),
	            magnetDepthScale: gl.getUniformLocation(this._program, 'u_magnetDepthScale')
	        };

        // Fixed uniforms
        gl.uniform2f(this._u.texSize, this.texWidth, this.texHeight);
        gl.uniform1i(this._u.count, this.count);
        // sampler bindings are assigned per-step
    }

    _initRandomTexture() {
        const gl = this.gl;
        // Store stable randoms as RGBA8; texelFetch returns normalized floats.
        const bytes = new Uint8Array(this.capacity * 4);
        const rng = mulberry32(this.seed ^ 0x9E3779B9);
        for (let i = 0; i < bytes.length; i++) bytes[i] = (rng() * 256) | 0;
        this._randTex = createTexture2D(gl, {
            width: this.texWidth,
            height: this.texHeight,
            internalFormat: gl.RGBA8,
            format: gl.RGBA,
            type: gl.UNSIGNED_BYTE,
            data: bytes,
            minFilter: gl.NEAREST,
            magFilter: gl.NEAREST
        });
    }

    _initDefaultFieldTexture() {
        const gl = this.gl;
        // RGBA8: dir=(0,0) encoded as 0.5,0.5 and mag=0.
        const bytes = new Uint8Array([128, 128, 0, 255]);
        this._defaultFieldTex = createTexture2D(gl, {
            width: 1,
            height: 1,
            internalFormat: gl.RGBA8,
            format: gl.RGBA,
            type: gl.UNSIGNED_BYTE,
            data: bytes,
            minFilter: gl.LINEAR,
            magFilter: gl.LINEAR
        });
    }

    /**
     * Set target textures for from/to shapes.
     * These must match the sim texture dimensions and store packed xyz positions in RGB.
     */
    setTargets({ fromTex, toTex }) {
        this._targetFrom = fromTex;
        this._targetTo = toTex;
    }

    /**
     * Set the low-res vector field texture corresponding to the "to" logo.
     * If not provided, a neutral field is used.
     */
    setToFieldTexture(toFieldTex) {
        this._toFieldTex = toFieldTex || null;
    }

    /**
     * Reset sim state to a random scattered cloud (velocity=0).
     * Optionally accepts a Float32Array posData/velData (RGBA32F) to initialize from.
     */
    reset({ posData = null, velData = null } = {}) {
        const gl = this.gl;
        const cap = this.capacity;

        const pos = posData || new Float32Array(cap * 4);
        const vel = velData || new Float32Array(cap * 4);

        if (!posData) {
            const rng = mulberry32(this.seed ^ 0xA5A5A5A5);
            for (let i = 0; i < cap; i++) {
                const o = i * 4;
                pos[o + 0] = (rng() * 2 - 1) * 1.1;
                pos[o + 1] = (rng() * 2 - 1) * 1.1;
                pos[o + 2] = (rng() * 2 - 1) * 1.1;
                pos[o + 3] = rng(); // aux
            }
        }

        // Upload to both ping and pong so we start stable
        for (let i = 0; i < 2; i++) {
            gl.bindTexture(gl.TEXTURE_2D, this._posTex[i]);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.texWidth, this.texHeight, gl.RGBA, gl.FLOAT, pos);
            gl.bindTexture(gl.TEXTURE_2D, this._velTex[i]);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.texWidth, this.texHeight, gl.RGBA, gl.FLOAT, vel);
        }
        gl.bindTexture(gl.TEXTURE_2D, null);

        this._idx = 0;
        this.time = 0;
    }

    /**
     * Advance simulation by dt seconds.
     * `params` should contain timeline values + preset parameters.
     */
    step(dt, params = {}) {
        const gl = this.gl;
        if (!this._targetFrom || !this._targetTo) return;

        // Simulation pass must render *exactly* the new state into float textures.
        // If blending is left enabled from the main renderer, some browsers/drivers will either:
        // - produce incorrect blended state, or
        // - fail outright when blending into float attachments (needs EXT_float_blend).
        // We temporarily disable blending (and depth test) for maximum compatibility.
        const wasBlend = gl.isEnabled(gl.BLEND);
        const wasDepth = gl.isEnabled(gl.DEPTH_TEST);
        const prevViewport = gl.getParameter(gl.VIEWPORT);
        if (wasBlend) gl.disable(gl.BLEND);
        if (wasDepth) gl.disable(gl.DEPTH_TEST);

        const src = this._idx;
        const dst = 1 - this._idx;
        const dtn = Math.max(0, Math.min(0.05, Number(dt) || 0));
        this.time += dtn;

        // Bind FBO for next state
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbos[dst]);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
        gl.viewport(0, 0, this.texWidth, this.texHeight);
        gl.useProgram(this._program);

        // Bind textures
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._posTex[src]);
        gl.uniform1i(this._u.posTex, 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this._velTex[src]);
        gl.uniform1i(this._u.velTex, 1);

        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this._randTex);
        gl.uniform1i(this._u.randTex, 2);

        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, this._targetFrom);
        gl.uniform1i(this._u.targetFrom, 3);

        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, this._targetTo);
        gl.uniform1i(this._u.targetTo, 4);

        gl.activeTexture(gl.TEXTURE5);
        gl.bindTexture(gl.TEXTURE_2D, this._toFieldTex || this._defaultFieldTex);
        gl.uniform1i(this._u.toFieldTex, 5);

        // Uniforms
        gl.uniform1f(this._u.dt, dtn);
        gl.uniform1f(this._u.time, this.time);

        gl.uniform1f(this._u.morphT, clamp01(params.morphT));
        gl.uniform1f(this._u.scatterT, clamp01(params.scatterT));
        gl.uniform1f(this._u.chaosT, clamp01(params.chaosT));
        gl.uniform1f(this._u.attractT, clamp01(params.attractT));
        gl.uniform1f(this._u.settleT, clamp01(params.settleT));

        gl.uniform1f(this._u.orbitT, clamp01(params.orbitT));
        // burstT is signed [-1,1]
        gl.uniform1f(this._u.burstT, Math.max(-1, Math.min(1, Number(params.burstT) || 0)));
        gl.uniform1f(this._u.nextFieldT, clamp01(params.nextFieldT));
        const orbitCenter = params.orbitCenter || [0, 0];
        gl.uniform2f(this._u.orbitCenter, Number(orbitCenter[0]) || 0, Number(orbitCenter[1]) || 0);
        gl.uniform1f(this._u.orbitRadius, Number(params.orbitRadius) || 0.65);
        gl.uniform1f(this._u.orbitOmega, Number(params.orbitOmega) || 0);
        gl.uniform1f(this._u.orbitGain, Number(params.orbitGain) || 0);
        gl.uniform1f(this._u.orbitRingK, Number(params.orbitRingK) || 0);

        const burstCenter = params.burstCenter || [0, 0];
        gl.uniform2f(this._u.burstCenter, Number(burstCenter[0]) || 0, Number(burstCenter[1]) || 0);
        gl.uniform1f(this._u.burstStrength, Number(params.burstStrength) || 0);
        gl.uniform1f(this._u.nextFieldStrength, Number(params.nextFieldStrength) || 0);

        const noiseOffset = params.noiseOffset || [0, 0];
        gl.uniform2f(this._u.noiseOffset, Number(noiseOffset[0]) || 0, Number(noiseOffset[1]) || 0);
        gl.uniform1f(this._u.noiseScale, Number(params.noiseScale) || 3.2);
        gl.uniform1f(this._u.noiseStrength, Number(params.noiseStrength) || 0.85);
        gl.uniform1f(this._u.noiseSpeed, Number(params.noiseSpeed) || 0.18);

        const v1 = params.vortex1 || [0.0, 0.0];
        const v2 = params.vortex2 || [-0.2, 0.15];
        const v3 = params.vortex3 || [0.25, -0.1];
        gl.uniform2f(this._u.vortex1, Number(v1[0]) || 0, Number(v1[1]) || 0);
        gl.uniform2f(this._u.vortex2, Number(v2[0]) || 0, Number(v2[1]) || 0);
        gl.uniform2f(this._u.vortex3, Number(v3[0]) || 0, Number(v3[1]) || 0);
        gl.uniform1f(this._u.vortexStrength, Number(params.vortexStrength) || 1.25);
        gl.uniform1f(this._u.vortexRadius, Number(params.vortexRadius) || 0.65);

	        gl.uniform1f(this._u.repulseStrength, Number(params.repulseStrength) || 1.0);
	        gl.uniform1f(this._u.attractStrength, Number(params.attractStrength) || 2.4);
	        gl.uniform1f(this._u.drag, Number(params.drag) || 1.1);
	        gl.uniform1f(this._u.maxSpeed, Number(params.maxSpeed) || 2.2);
	
	        // MagnetTool uniforms
	        const magnet = params.magnet || null;
	        const mEnabled = !!(magnet && magnet.enabled);
	        gl.uniform1f(this._u.magnetEnabled, mEnabled ? 1.0 : 0.0);
	        if (mEnabled) {
	            gl.uniform2f(this._u.magnetCenter, Number(magnet.centerX) || 0, Number(magnet.centerY) || 0);
	            gl.uniform2f(
	                this._u.magnetRadius,
	                Math.max(1e-6, Number(magnet.radiusClipX) || 1e-6),
	                Math.max(1e-6, Number(magnet.radiusClipY) || 1e-6)
	            );
	            gl.uniform1f(this._u.magnetStrength, Number(magnet.strength) || 0);
	            gl.uniform1f(this._u.magnetSign, (magnet.mode === 'repel') ? 1.0 : -1.0);
	            gl.uniform1f(this._u.magnetZoom, Number(magnet.zoom) || 1.0);
	            gl.uniform1f(this._u.magnetDepthScale, (typeof magnet.depthScale === 'number') ? magnet.depthScale : 0.5);
	        } else {
	            gl.uniform2f(this._u.magnetCenter, 0, 0);
	            gl.uniform2f(this._u.magnetRadius, 1, 1);
	            gl.uniform1f(this._u.magnetStrength, 0);
	            gl.uniform1f(this._u.magnetSign, -1.0);
	            gl.uniform1f(this._u.magnetZoom, 1.0);
	            gl.uniform1f(this._u.magnetDepthScale, 0.5);
	        }

	        // Draw
	        gl.bindVertexArray(this._vao);
	        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);

        // Cleanup
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        // Restore state for the main renderer
        if (prevViewport && prevViewport.length === 4) {
            gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
        }
        if (wasBlend) gl.enable(gl.BLEND);
        if (wasDepth) gl.enable(gl.DEPTH_TEST);

        this._idx = dst;
    }

    getPositionTexture() {
        return this._posTex[this._idx];
    }

    getVelocityTexture() {
        return this._velTex[this._idx];
    }

    getRandomTexture() {
        return this._randTex;
    }

    dispose() {
        const gl = this.gl;
        safeDelete(gl, {
            program: this._program,
            textures: [...this._posTex, ...this._velTex, this._randTex, this._defaultFieldTex].filter(Boolean),
            framebuffers: this._fbos.filter(Boolean),
            buffers: [this._vbo].filter(Boolean),
            vaos: [this._vao].filter(Boolean)
        });
        this._program = null;
        this._vao = null;
        this._vbo = null;
        this._fbos = [null, null];
        this._posTex = [null, null];
        this._velTex = [null, null];
        this._randTex = null;
        this._toFieldTex = null;
        this._defaultFieldTex = null;
    }
}

function clamp01(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function hash32(str) {
    const s = String(str || '');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function rng() {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
