/**
 * WebGL Renderer Module
 * High-performance particle rendering with glow effects
 */

export class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = null;
        this.program = null;
        this.bloomProgram = null;
        this.gpuProgram = null;
        this.post = null;
        this._gpuVAO = null;
        this._postVAO = null;
        this._postVBO = null;
        this._supportsFloatColor = false;
        this._time = 0;
        this._hexToRgbCache = new Map();
        this._bufferByteLens = new WeakMap();
        this._cpuArrayCapacity = 0;
        this._cpuArrays = null;
        this._spriteCache = new Map();
        this._spriteSize = 128;
        this._spriteFallbackTex = null;
        this._whiteTex = null;
        this.settings = {
            glowIntensity: 0.4,
            depthVariance: 0.5,
            zoom: 1.0,
            rotationX: 0,
            rotationY: 0,
            // Logo-wide gradient overlay (CPU path; GPU path handled separately)
            gradientOverlayEnabled: false,
            gradientColorA: '#00d4ff',
            gradientColorB: '#a855f7',
            gradientStrength: 0.7, // 0..1
            gradientDirection: 'diag', // 'ltr' | 'ttb' | 'diag' | 'radial'
            spriteEnabled: false,
            spriteColorMode: 'tint',
            spriteRotate: true,
            sprite: null,
            colorMode: 'original',
            chromaticShift: 0.18
        };

        // On-canvas overlay (e.g., MagnetTool circle). Stored in clip space so it’s resolution independent.
        this._overlayCircle = {
            enabled: false,
            centerX: 0,
            centerY: 0,
            radiusClipX: 0.2,
            radiusClipY: 0.2,
            radiusPx: 140,
            mode: 'attract',
            color: [0.0, 1.0, 0.533]
        };
        this._overlayProgram = null;
        this._overlayUniforms = null;

        // Buffers
        this.positionBuffer = null;
        this.colorBuffer = null;
        this.sizeBuffer = null;
        this.shapeBuffer = null;
        this.angleBuffer = null;
        this.aspectBuffer = null;
        this.layerBuffer = null;

        // Framebuffers for bloom
        this.mainFB = null;
        this.bloomFB = null;

        this.init();
    }

    /**
     * Initialize WebGL context and shaders
     */
    init() {
        // Get WebGL2 context
        this.gl = this.canvas.getContext('webgl2', {
            alpha: true,
            premultipliedAlpha: false,
            antialias: true,
            preserveDrawingBuffer: true
        });

        if (!this.gl) {
            console.error('WebGL2 not supported, falling back to Canvas2D');
            this.fallbackToCanvas2D = true;
            return;
        }

        const gl = this.gl;

        this._supportsFloatColor = !!gl.getExtension('EXT_color_buffer_float');

        // Enable blending
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        // Create shaders
        this.createShaders();
        this.createGPUShaders();

        // Create buffers
        this.positionBuffer = gl.createBuffer();
        this.colorBuffer = gl.createBuffer();
        this.sizeBuffer = gl.createBuffer();
        this.opacityBuffer = gl.createBuffer();
        this.shapeBuffer = gl.createBuffer();
        this.angleBuffer = gl.createBuffer();
        this.aspectBuffer = gl.createBuffer();
        this.layerBuffer = gl.createBuffer();

        // Create framebuffers for bloom effect
        this.createFramebuffers();

        // Overlay shader (MagnetTool circle, etc.)
        this.createOverlayProgram();
    }

    /**
     * Create shader programs
     */
    createShaders() {
        const gl = this.gl;

        // Vertex shader for particles
        const vertexShaderSource = `#version 300 es
            precision highp float;
            
            in vec3 a_position;
            in vec3 a_color;
            in float a_size;
            in float a_opacity;
            in float a_shape;
            in float a_angle;
            in float a_aspect;
            in float a_layer;
            
            uniform float u_pointSize;
            uniform vec2 u_resolution;
            uniform vec2 u_aspect;
            uniform float u_depthScale;
            uniform float u_zoom;
            uniform float u_rotX;
            uniform float u_rotY;
            uniform float u_focusEnabled;
            uniform vec2 u_focusCenter;
            uniform float u_focusRadius;
            uniform float u_focusSoftness;
            uniform float u_focusScatter;
            
            out vec3 v_color;
            out float v_opacity;
            out float v_shape;
            out float v_angle;
            out float v_aspect;
            
            void main() {
                // View rotation (done in shader so simulation isn't disturbed)
                float cx = cos(u_rotX);
                float sx = sin(u_rotX);
                float cy = cos(u_rotY);
                float sy = sin(u_rotY);

                mat3 rotX = mat3(
                    1.0, 0.0, 0.0,
                    0.0, cx, -sx,
                    0.0, sx, cx
                );

                mat3 rotY = mat3(
                    cy, 0.0, sy,
                    0.0, 1.0, 0.0,
                    -sy, 0.0, cy
                );

                float isAmbient = step(0.5, a_layer);
                float depthScale = u_depthScale;
                if (u_focusEnabled > 0.5 && isAmbient < 0.5) {
                    float radius = max(u_focusRadius, 1e-5);
                    float soft = max(u_focusSoftness, 1e-5);
                    vec2 focusVec = (a_position.xy - u_focusCenter) * u_aspect;
                    float dist = length(focusVec);
                    float edge = smoothstep(radius, radius + soft, dist);
                    float insideMul = 0.25;
                    float outsideMul = max(0.0, u_focusScatter);
                    depthScale = u_depthScale * mix(insideMul, outsideMul, edge);
                }

                // Apply "Depth Variance" to the particle's Z BEFORE rotating.
                // This makes the slider actually control 3D parallax when rotating the view.
                vec3 posIn = vec3(a_position.xy, a_position.z * depthScale);
                vec3 pos = rotY * rotX * posIn;

                // Depth-based scaling
                float depth = pos.z;
                float scale = 1.0 - depth * 0.3;
                
                // Apply zoom
                // Background cosmos must always fill the screen: keep ambient in screen space (no zoom scaling).
                float zoomFactor = mix(u_zoom, 1.0, isAmbient);
                vec2 zoomedPos = pos.xy * zoomFactor;
                
                // Prevent "perspective" scaling from pushing logo-space particles outside clip space.
                // This avoids hard edge clipping in exports at higher depth variance / rotations.
                float depthScaleClamped = clamp(depthScale, 0.0, 1.0);
                float perspNorm = 0.985 / (1.0 + depthScaleClamped * 0.3);
                float posNorm = mix(perspNorm, 1.0, isAmbient);
                
                vec2 clipPos = zoomedPos * scale * posNorm;
                gl_Position = vec4(clipPos * u_aspect, depth, 1.0);
                gl_PointSize = a_size * u_pointSize * scale * zoomFactor * posNorm;
                
                v_color = a_color;
                v_opacity = a_opacity * (1.0 - abs(depth) * 0.3);
                v_shape = a_shape;
                v_angle = a_angle;
                v_aspect = a_aspect;
            }
        `;

        // Fragment shader for particles with soft circle
        const fragmentShaderSource = `#version 300 es
            precision highp float;
            precision highp sampler2D;
            
            in vec3 v_color;
            in float v_opacity;
            in float v_shape;
            in float v_angle;
            in float v_aspect;
            
            uniform float u_glowIntensity;
            uniform sampler2D u_sprite;
            uniform float u_spriteEnabled;
            uniform float u_spriteColorMode;
            uniform float u_spriteRotate;
            uniform vec2 u_resolution;
            uniform float u_chromatic;
            uniform float u_chromaticShift;
            
            out vec4 fragColor;
            
            void main() {
                vec2 coord = gl_PointCoord - vec2(0.5);
                bool chroma = (u_chromatic > 0.5);
                vec2 chromaOffsetR = vec2(0.0);
                vec2 chromaOffsetG = vec2(0.0);
                vec2 chromaOffsetB = vec2(0.0);
                if (chroma) {
                    vec2 ndc = (gl_FragCoord.xy / u_resolution) * 2.0 - 1.0;
                    float ndcLen = length(ndc);
                    vec2 dir = (ndcLen > 1e-4) ? (ndc / ndcLen) : vec2(1.0, 0.0);
                    float chromaRadius = clamp(ndcLen, 0.0, 1.0);
                    float chromaScale = chromaRadius * chromaRadius;
                    vec2 baseOffset = dir * u_chromaticShift * chromaScale;
                    chromaOffsetR = baseOffset * 0.9;
                    chromaOffsetG = baseOffset * 0.2;
                    chromaOffsetB = baseOffset * -1.0;
                }

                if (u_spriteEnabled > 0.5) {
                    float a = (u_spriteRotate > 0.5) ? v_angle : 0.0;
                    float ca = cos(a);
                    float sa = sin(a);
                    mat2 rot = mat2(ca, -sa, sa, ca);
                    vec2 uv = rot * coord + vec2(0.5);
                    vec4 sprite = texture(u_sprite, uv);
                    float alphaMask = sprite.a;
                    float glow = alphaMask * u_glowIntensity * 0.35;
                    float alpha = (alphaMask + glow) * v_opacity;
                    if (chroma) {
                        vec2 uvR = rot * (coord + chromaOffsetR) + vec2(0.5);
                        vec2 uvG = rot * (coord + chromaOffsetG) + vec2(0.5);
                        vec2 uvB = rot * (coord + chromaOffsetB) + vec2(0.5);
                        float aR = texture(u_sprite, uvR).a;
                        float aG = texture(u_sprite, uvG).a;
                        float aB = texture(u_sprite, uvB).a;
                        float mR = (aR + aR * u_glowIntensity * 0.35) * v_opacity;
                        float mG = (aG + aG * u_glowIntensity * 0.35) * v_opacity;
                        float mB = (aB + aB * u_glowIntensity * 0.35) * v_opacity;
                        float maxA = max(mG, max(mR, mB));
                        if (maxA < 0.01) discard;
                        vec3 col = vec3(mR, mG, mB) / max(maxA, 1e-5);
                        fragColor = vec4(col, maxA);
                        return;
                    }

                    if (alpha < 0.01) discard;
                    vec3 base = (u_spriteColorMode > 0.5) ? (sprite.rgb * v_color) : v_color;
                    fragColor = vec4(base, alpha);
                    return;
                }

                // Apple-ish star sprites: mix circles and tiny rectangles, with glow.
                // Circle distance
                float dCircle = length(coord);

                // Rotated rectangle distance (uses v_aspect as width/height ratio)
                float ca = cos(v_angle);
                float sa = sin(v_angle);
                mat2 rot = mat2(ca, -sa, sa, ca);
                vec2 uv = rot * coord;
                float aspect = max(1.0, v_aspect);
                // Thin rectangle: y scaled up by aspect => tighter vertically
                float dRect = max(abs(uv.x), abs(uv.y) * aspect);

                float useRect = step(0.5, v_shape);
                float d = mix(dCircle, dRect, useRect);

                // Anti-aliased edges:
                // fwidth(d) scales with gl_PointSize, keeping the edge transition ~constant in screen pixels.
                // This prevents large particles from looking "blurry".
                float aa = max(fwidth(d), 1e-4);

                // Core disc with a thin AA edge at the sprite boundary.
                float core = smoothstep(0.5, 0.5 - aa * 1.35, d);

                // Glow halo: starts near the edge of the core and falls off outward.
                float glow = smoothstep(0.75, 0.5 - aa * 1.35, d) * u_glowIntensity * 0.55;
                
                float alpha = (core + glow) * v_opacity;
                if (chroma) {
                    vec2 uvR = rot * (coord + chromaOffsetR);
                    vec2 uvG = rot * (coord + chromaOffsetG);
                    vec2 uvB = rot * (coord + chromaOffsetB);
                    float dCircleR = length(coord + chromaOffsetR);
                    float dCircleG = length(coord + chromaOffsetG);
                    float dCircleB = length(coord + chromaOffsetB);
                    float dRectR = max(abs(uvR.x), abs(uvR.y) * aspect);
                    float dRectG = max(abs(uvG.x), abs(uvG.y) * aspect);
                    float dRectB = max(abs(uvB.x), abs(uvB.y) * aspect);
                    float dR = mix(dCircleR, dRectR, useRect);
                    float dG = mix(dCircleG, dRectG, useRect);
                    float dB = mix(dCircleB, dRectB, useRect);
                    float coreR = smoothstep(0.5, 0.5 - aa * 1.35, dR);
                    float glowR = smoothstep(0.75, 0.5 - aa * 1.35, dR) * u_glowIntensity * 0.55;
                    float coreG = smoothstep(0.5, 0.5 - aa * 1.35, dG);
                    float glowG = smoothstep(0.75, 0.5 - aa * 1.35, dG) * u_glowIntensity * 0.55;
                    float coreB = smoothstep(0.5, 0.5 - aa * 1.35, dB);
                    float glowB = smoothstep(0.75, 0.5 - aa * 1.35, dB) * u_glowIntensity * 0.55;
                    float mR = (coreR + glowR) * v_opacity;
                    float mG = (coreG + glowG) * v_opacity;
                    float mB = (coreB + glowB) * v_opacity;
                    float maxA = max(mG, max(mR, mB));
                    if (maxA < 0.01) discard;
                    vec3 col = vec3(mR, mG, mB) / max(maxA, 1e-5);
                    fragColor = vec4(col, maxA);
                    return;
                }

                if (alpha < 0.01) discard;
                fragColor = vec4(v_color, alpha);
            }
        `;

        // Compile and link
        const vertexShader = this.compileShader(gl.VERTEX_SHADER, vertexShaderSource);
        const fragmentShader = this.compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);

        this.program = gl.createProgram();
        gl.attachShader(this.program, vertexShader);
        gl.attachShader(this.program, fragmentShader);
        gl.linkProgram(this.program);

        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
            console.error('Shader program failed to link:', gl.getProgramInfoLog(this.program));
        }

        // Get attribute and uniform locations
        this.attribLocations = {
            position: gl.getAttribLocation(this.program, 'a_position'),
            color: gl.getAttribLocation(this.program, 'a_color'),
            size: gl.getAttribLocation(this.program, 'a_size'),
            opacity: gl.getAttribLocation(this.program, 'a_opacity'),
            shape: gl.getAttribLocation(this.program, 'a_shape'),
            angle: gl.getAttribLocation(this.program, 'a_angle'),
            aspect: gl.getAttribLocation(this.program, 'a_aspect'),
            layer: gl.getAttribLocation(this.program, 'a_layer')
        };

        this.uniformLocations = {
            pointSize: gl.getUniformLocation(this.program, 'u_pointSize'),
            resolution: gl.getUniformLocation(this.program, 'u_resolution'),
            aspect: gl.getUniformLocation(this.program, 'u_aspect'),
            depthScale: gl.getUniformLocation(this.program, 'u_depthScale'),
            glowIntensity: gl.getUniformLocation(this.program, 'u_glowIntensity'),
            zoom: gl.getUniformLocation(this.program, 'u_zoom'),
            rotX: gl.getUniformLocation(this.program, 'u_rotX'),
            rotY: gl.getUniformLocation(this.program, 'u_rotY'),
            focusEnabled: gl.getUniformLocation(this.program, 'u_focusEnabled'),
            focusCenter: gl.getUniformLocation(this.program, 'u_focusCenter'),
            focusRadius: gl.getUniformLocation(this.program, 'u_focusRadius'),
            focusSoftness: gl.getUniformLocation(this.program, 'u_focusSoftness'),
            focusScatter: gl.getUniformLocation(this.program, 'u_focusScatter'),
            spriteTex: gl.getUniformLocation(this.program, 'u_sprite'),
            spriteEnabled: gl.getUniformLocation(this.program, 'u_spriteEnabled'),
            spriteColorMode: gl.getUniformLocation(this.program, 'u_spriteColorMode'),
            spriteRotate: gl.getUniformLocation(this.program, 'u_spriteRotate'),
            chromatic: gl.getUniformLocation(this.program, 'u_chromatic'),
            chromaticShift: gl.getUniformLocation(this.program, 'u_chromaticShift')
        };

        // Create post-processing shader for bloom
        this.createBloomShader();
    }

    /**
     * GPU particle renderer (positions/velocities/randoms sampled from textures via gl_VertexID).
     * This is used for 200k–2M cinematic renders and offline export.
     */
    createGPUShaders() {
        const gl = this.gl;
        if (!gl) return;

        const vs = `#version 300 es
            precision highp float;
            precision highp sampler2D;

            uniform sampler2D u_posTex;
            uniform sampler2D u_velTex;
            uniform sampler2D u_randTex;
            uniform sampler2D u_targetFrom;
            uniform sampler2D u_targetTo;
            uniform sampler2D u_colorTexFrom;
            uniform sampler2D u_colorTexTo;
            uniform float u_useColorTex;
            uniform float u_colorTexBlend;

            uniform int u_texWidth;
            uniform int u_count;

            uniform float u_pointSize;
            uniform vec2 u_resolution;
            uniform vec2 u_aspect;
            uniform float u_depthScale;
            uniform float u_zoom;
            uniform float u_rotX;
            uniform float u_rotY;
	            uniform float u_focusEnabled;
	            uniform vec2 u_focusCenter;
	            uniform float u_focusRadius;
	            uniform float u_focusSoftness;
	            uniform float u_focusScatter;
	            uniform float u_time;
	            // UI-driven look controls (match CPU controls as closely as possible)
	            uniform float u_userSize;       // 0.5..5.0
	            uniform float u_sizeRandom;     // 0..1 (coverage)
	            uniform float u_sizeMin; // multiplier
	            uniform float u_sizeMax; // multiplier
	            // Transition blend (0..1) for stable logo-space coords (used by gradient overlay)
	            uniform float u_morphT;

            out vec4 v_rand;
            out vec3 v_vel;
            out float v_depth;
            out float v_edge;
            out vec2 v_logoXY;
            out vec3 v_color;
            out float v_colorA;

	            float hash12(vec2 p) {
	                return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
	            }

	            void main() {
                int id = gl_VertexID;
                if (id >= u_count) {
                    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
                    gl_PointSize = 0.0;
                    v_rand = vec4(0.0);
                    v_vel = vec3(0.0);
                    v_depth = 0.0;
                    v_edge = 0.0;
                    v_logoXY = vec2(0.0);
                    v_color = vec3(1.0);
                    v_colorA = 1.0;
                    return;
                }

                int x = id - (id / u_texWidth) * u_texWidth;
                int y = id / u_texWidth;
                ivec2 coord = ivec2(x, y);

                vec4 pos4 = texelFetch(u_posTex, coord, 0);
                vec4 vel4 = texelFetch(u_velTex, coord, 0);
                vec4 rnd = texelFetch(u_randTex, coord, 0);

                // Stable logo-space coordinate (mix between from/to targets)
                vec3 fromT = texelFetch(u_targetFrom, coord, 0).xyz;
                vec3 toT = texelFetch(u_targetTo, coord, 0).xyz;
                float mt = clamp(u_morphT, 0.0, 1.0);
                v_logoXY = mix(fromT.xy, toT.xy, mt);
                float edgeFrom = texelFetch(u_targetFrom, coord, 0).w;
                float edgeTo = texelFetch(u_targetTo, coord, 0).w;
                float edgeW = mix(edgeFrom, edgeTo, mt);
                float depthScale = u_depthScale;
                if (u_focusEnabled > 0.5) {
                    float radius = max(u_focusRadius, 1e-5);
                    float soft = max(u_focusSoftness, 1e-5);
                    vec2 focusVec = (v_logoXY - u_focusCenter) * u_aspect;
                    float dist = length(focusVec);
                    float edge = smoothstep(radius, radius + soft, dist);
                    float insideMul = 0.25;
                    float outsideMul = max(0.0, u_focusScatter);
                    depthScale = u_depthScale * mix(insideMul, outsideMul, edge);
                }
                float edgeRough = 1.0 - smoothstep(0.12, 0.32, clamp(depthScale, 0.0, 1.0));
                float edgeAmp = edgeW * edgeRough;
                float edgeJitter = edgeAmp * 0.008;
                vec2 edgeOffset = (rnd.xy * 2.0 - 1.0) * edgeJitter;
                v_edge = edgeAmp;

                vec3 imgColor = vec3(1.0);
                float imgIntensity = 1.0;
                if (u_useColorTex > 0.5) {
                    vec4 cFrom = texelFetch(u_colorTexFrom, coord, 0);
                    vec4 cTo = texelFetch(u_colorTexTo, coord, 0);
                    vec4 c = mix(cFrom, cTo, mt);
                    imgColor = c.rgb;
                    imgIntensity = c.a;
                }
                v_color = imgColor;
                v_colorA = imgIntensity;

                // View rotation (matching CPU path)
                float cx = cos(u_rotX);
                float sx = sin(u_rotX);
                float cy = cos(u_rotY);
                float sy = sin(u_rotY);

                mat3 rotX = mat3(
                    1.0, 0.0, 0.0,
                    0.0, cx, -sx,
                    0.0, sx, cx
                );

                mat3 rotY = mat3(
                    cy, 0.0, sy,
                    0.0, 1.0, 0.0,
                    -sy, 0.0, cy
                );

                vec3 posIn = vec3(pos4.xy + edgeOffset, pos4.z * depthScale);
                vec3 pos = rotY * rotX * posIn;

                float depth = pos.z;
                float scale = 1.0 - depth * 0.3;
                vec2 zoomedPos = pos.xy * u_zoom;
                
                // Normalize the perspective scale so it can't clip at the edges (export-safe framing).
                float depthScaleClamped = clamp(depthScale, 0.0, 1.0);
                float posNorm = 0.985 / (1.0 + depthScaleClamped * 0.3);

                vec2 clipPos = zoomedPos * scale * posNorm;
                gl_Position = vec4(clipPos * u_aspect, depth, 1.0);

	                // Particle size:
	                // - if selected (by u_sizeRandom coverage), pick a size in [u_sizeMin, u_sizeMax]
	                // - otherwise use u_userSize (base size slider)
	                float cov = clamp(u_sizeRandom, 0.0, 1.0);
	                float sel = hash12(rnd.xy);
	                float apply = 1.0 - step(cov, sel); // 1 when sel < cov, else 0
	
	                float smin = max(0.05, min(u_sizeMin, u_sizeMax));
	                float smax = max(0.05, max(u_sizeMin, u_sizeMax));
	                float tSize = hash12(rnd.yz + vec2(0.17, 0.53));
	                float randMul = mix(smin, smax, tSize);
	
	                float user = max(0.1, u_userSize);
	                float sizeFinal = user * mix(1.0, randMul, apply);
	
	                float colorBlend = clamp(u_colorTexBlend, 0.0, 1.0);
	                float imgMul = mix(0.8, 1.25, clamp(imgIntensity, 0.0, 1.0));
	                float intensityMul = mix(1.0, imgMul, colorBlend);
	                float base = u_pointSize * sizeFinal * scale * u_zoom * posNorm * intensityMul;
	                gl_PointSize = clamp(base, 0.0, 64.0);

                v_rand = rnd;
                v_vel = vel4.xyz;
                v_depth = depth;
            }
        `;

        const fs = `#version 300 es
            precision highp float;
            precision highp sampler2D;

            in vec4 v_rand;
            in vec3 v_vel;
            in float v_depth;
            in float v_edge;
            in vec2 v_logoXY;
            in vec3 v_color;
            in float v_colorA;

            uniform float u_glowIntensity;
            uniform vec3 u_lightDir;
            uniform float u_exposure;
            uniform float u_sparkleIntensity;
	            uniform float u_time;
	            // UI-driven look controls
	            uniform float u_opacityRandom;   // 0..1 (coverage)
	            uniform float u_opacityMin;
	            uniform float u_opacityMax;
	            uniform float u_squaresEnabled;  // 0/1
	            uniform float u_squareRatio;     // 0..1
            uniform sampler2D u_spriteTex;
            uniform float u_spriteEnabled;    // 0/1
            uniform float u_spriteColorMode;  // 0=tint, 1=svg colors
            uniform float u_spriteRotate;     // 0/1
            uniform float u_realColors;      // 0/1
            uniform float u_useColorOverride;// 0/1
            uniform vec3 u_colorOverride;    // rgb 0..1
            uniform float u_useColorTex;     // 0/1
            uniform float u_colorTexBlend;  // 0..1
            uniform float u_countRatio;     // 0..1
            uniform float u_countSoftness;  // 0..1
            uniform vec2 u_resolution;
            uniform float u_chromatic;      // 0/1
            uniform float u_chromaticShift; // 0..1
            // Logo-wide gradient overlay (tint)
            uniform float u_gradientEnabled;   // 0/1
            uniform float u_gradientStrength;  // 0..1
            uniform float u_gradientDirection; // 0=ltr,1=ttb,2=diag,3=radial
            uniform vec3 u_gradientColorA;     // rgb 0..1
            uniform vec3 u_gradientColorB;     // rgb 0..1

	            float hash12(vec2 p) {
	                return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
	            }

	            out vec4 fragColor;

            void main() {
                vec2 coord = gl_PointCoord - vec2(0.5);
                vec4 sprite = vec4(0.0);
                float core = 0.0;
                float halo = 0.0;
                float useRect = 0.0;
                float aa = 0.0;
                mat2 rot = mat2(1.0);

                bool chroma = (u_chromatic > 0.5);
                vec2 chromaOffsetR = vec2(0.0);
                vec2 chromaOffsetG = vec2(0.0);
                vec2 chromaOffsetB = vec2(0.0);
                if (chroma) {
                    vec2 ndc = (gl_FragCoord.xy / u_resolution) * 2.0 - 1.0;
                    float ndcLen = length(ndc);
                    vec2 dir = (ndcLen > 1e-4) ? (ndc / ndcLen) : vec2(1.0, 0.0);
                    float chromaRadius = clamp(ndcLen, 0.0, 1.0);
                    float chromaScale = chromaRadius * chromaRadius;
                    vec2 baseOffset = dir * u_chromaticShift * chromaScale;
                    chromaOffsetR = baseOffset * 0.9;
                    chromaOffsetG = baseOffset * 0.2;
                    chromaOffsetB = baseOffset * -1.0;
                }

                if (u_spriteEnabled > 0.5) {
                    float a = (u_spriteRotate > 0.5) ? (v_rand.x * 6.28318530718) : 0.0;
                    float ca = cos(a);
                    float sa = sin(a);
                    rot = mat2(ca, -sa, sa, ca);
                    vec2 uv = rot * coord + vec2(0.5);
                    sprite = texture(u_spriteTex, uv);
                    float alphaMask = sprite.a;
                    core = alphaMask;
                    halo = alphaMask * u_glowIntensity * 0.35;
                } else {
                    float dCircle = length(coord);

                    // Optional square sprites (matches CPU "Squares" control)
                    if (u_squaresEnabled > 0.5 && u_squareRatio > 0.0) {
                        // 1 when v_rand.x < ratio, else 0
                        useRect = 1.0 - step(clamp(u_squareRatio, 0.0, 1.0), v_rand.x);
                    }
                    float a = v_rand.w * 6.28318530718; // 2π
                    float ca = cos(a);
                    float sa = sin(a);
                    rot = mat2(ca, -sa, sa, ca);
                    vec2 uv = rot * coord;
                    float dRect = max(abs(uv.x), abs(uv.y)); // aspect=1
                    float d = mix(dCircle, dRect, useRect);

                    // Core + halo (bloom will take over for large glow)
                    // Derivative-based AA keeps the edge crisp at larger point sizes.
                    aa = max(fwidth(d), 1e-4);
                    core = smoothstep(0.5, 0.5 - aa * 1.35, d);
                    halo = smoothstep(0.8, 0.5 - aa * 1.35, d) * u_glowIntensity * 0.8;
                }

	                // Base alpha:
	                // - if selected (by u_opacityRandom coverage), pick an alpha in [u_opacityMin, u_opacityMax]
	                // - otherwise use the baseline (0.75)
	                float cov = clamp(u_opacityRandom, 0.0, 1.0);
	                float sel = hash12(v_rand.zw + vec2(0.11, 0.73));
	                float apply = 1.0 - step(cov, sel); // 1 when sel < cov, else 0
	
	                float omin = clamp(min(u_opacityMin, u_opacityMax), 0.0, 1.0);
	                float omax = clamp(max(u_opacityMin, u_opacityMax), 0.0, 1.0);
	                float tA = hash12(v_rand.xy + vec2(0.33, 0.19));
	                float randA = mix(omin, omax, tA);
	                float baseA = clamp(mix(0.75, randA, apply), 0.08, 1.0);
	                float depthFade = 1.0 - abs(v_depth) * 0.25;
                    float baseMask = core + halo;
	                float alpha = baseMask * baseA * depthFade;
                    float edgeRough = clamp(v_edge, 0.0, 1.0);
                    if (edgeRough > 1e-4) {
                        float edgeCutAmount = 0.34 * edgeRough;
                        float edgeDropProb = 0.20 * edgeRough;
                        float edgeAlphaAmount = 0.62 * edgeRough;

                        float edgeCutRand = v_rand.x;
                        float edgeCutMul = (edgeCutRand < edgeDropProb)
                            ? 0.0
                            : smoothstep(edgeDropProb, edgeCutAmount, edgeCutRand);

                        float u = v_rand.y;
                        float edgeAlphaRand = 0.25 + 0.75 * (u * u);
                        float edgeAlphaMul = (1.0 - edgeAlphaAmount) + edgeAlphaAmount * edgeAlphaRand;

                        alpha *= edgeCutMul * edgeAlphaMul;
                    }
                if (u_useColorTex > 0.5) {
                    float imgA = clamp(v_colorA, 0.0, 1.0);
                    float imgMul = 0.35 + imgA * 0.85;
                    float colorBlend = clamp(u_colorTexBlend, 0.0, 1.0);
                    alpha *= mix(1.0, imgMul, colorBlend);
                }

                float countRatio = clamp(u_countRatio, 0.0, 1.0);
                if (countRatio < 0.999) {
                    float soft = max(1e-4, u_countSoftness);
                    float edge = min(1.0, countRatio + soft);
                    float tCount = smoothstep(countRatio, edge, v_rand.x);
                    alpha *= tCount;
                }
                vec3 base;
                if (chroma) {
                    float alphaFactor = (baseMask > 1e-5) ? (alpha / baseMask) : 0.0;
                    float maskR = 0.0;
                    float maskG = 0.0;
                    float maskB = 0.0;
                    if (u_spriteEnabled > 0.5) {
                        vec2 uvR = rot * (coord + chromaOffsetR) + vec2(0.5);
                        vec2 uvG = rot * (coord + chromaOffsetG) + vec2(0.5);
                        vec2 uvB = rot * (coord + chromaOffsetB) + vec2(0.5);
                        float aR = texture(u_spriteTex, uvR).a;
                        float aG = texture(u_spriteTex, uvG).a;
                        float aB = texture(u_spriteTex, uvB).a;
                        maskR = (aR + aR * u_glowIntensity * 0.35) * alphaFactor;
                        maskG = (aG + aG * u_glowIntensity * 0.35) * alphaFactor;
                        maskB = (aB + aB * u_glowIntensity * 0.35) * alphaFactor;
                    } else {
                        float dCircleR = length(coord + chromaOffsetR);
                        float dCircleG = length(coord + chromaOffsetG);
                        float dCircleB = length(coord + chromaOffsetB);
                        vec2 uvR = rot * (coord + chromaOffsetR);
                        vec2 uvG = rot * (coord + chromaOffsetG);
                        vec2 uvB = rot * (coord + chromaOffsetB);
                        float dRectR = max(abs(uvR.x), abs(uvR.y));
                        float dRectG = max(abs(uvG.x), abs(uvG.y));
                        float dRectB = max(abs(uvB.x), abs(uvB.y));
                        float dR = mix(dCircleR, dRectR, useRect);
                        float dG = mix(dCircleG, dRectG, useRect);
                        float dB = mix(dCircleB, dRectB, useRect);
                        float coreR = smoothstep(0.5, 0.5 - aa * 1.35, dR);
                        float haloR = smoothstep(0.8, 0.5 - aa * 1.35, dR) * u_glowIntensity * 0.8;
                        float coreG = smoothstep(0.5, 0.5 - aa * 1.35, dG);
                        float haloG = smoothstep(0.8, 0.5 - aa * 1.35, dG) * u_glowIntensity * 0.8;
                        float coreB = smoothstep(0.5, 0.5 - aa * 1.35, dB);
                        float haloB = smoothstep(0.8, 0.5 - aa * 1.35, dB) * u_glowIntensity * 0.8;
                        maskR = (coreR + haloR) * alphaFactor;
                        maskG = (coreG + haloG) * alphaFactor;
                        maskB = (coreB + haloB) * alphaFactor;
                    }
                    float maxA = max(maskG, max(maskR, maskB));
                    if (maxA < 0.01) discard;
                    alpha = maxA;
                    base = vec3(maskR, maskG, maskB) / max(maxA, 1e-5);
                } else {
                    if (alpha < 0.01) discard;
                    // Color: either "real colors" palette, or user override, else neutral white.
                    vec3 fallbackBase;
                    if (u_realColors > 0.5) {
                        // Metallic dust palette (cool/warm whites)
                        vec3 cool = vec3(0.84, 0.91, 1.0);
                        vec3 warm = vec3(1.0, 0.95, 0.86);
                        float temp = step(0.55, v_rand.x);
                        fallbackBase = mix(cool, warm, temp);
                        fallbackBase = mix(fallbackBase, vec3(1.0), 0.55);
                        fallbackBase *= 0.85 + 0.25 * v_rand.z;
                    } else if (u_useColorOverride > 0.5) {
                        fallbackBase = clamp(u_colorOverride, 0.0, 1.0);
                    } else {
                        fallbackBase = vec3(0.83, 0.83, 0.85);
                    }

                    vec3 tintBase = fallbackBase;
                    if (u_useColorTex > 0.5) {
                        float colorBlend = clamp(u_colorTexBlend, 0.0, 1.0);
                        tintBase = mix(fallbackBase, v_color, colorBlend);
                    }

                    if (u_spriteEnabled > 0.5 && u_spriteColorMode > 0.5) {
                        base = sprite.rgb;
                    } else {
                        base = tintBase;
                    }

                    // Logo-wide gradient tint (in logo space, not screen space)
                    if (u_gradientEnabled > 0.5 && u_gradientStrength > 1e-4) {
                        float t;
                        if (u_gradientDirection < 0.5) {
                            // Left -> Right
                            t = clamp(v_logoXY.x * 0.5 + 0.5, 0.0, 1.0);
                        } else if (u_gradientDirection < 1.5) {
                            // Top -> Bottom
                            t = clamp(0.5 - v_logoXY.y * 0.5, 0.0, 1.0);
                        } else if (u_gradientDirection < 2.5) {
                            // Diagonal (top-left -> bottom-right)
                            t = clamp((v_logoXY.x - v_logoXY.y + 2.0) * 0.25, 0.0, 1.0);
                        } else {
                            // Radial (center -> edge)
                            t = clamp(length(v_logoXY) / 1.41421356237, 0.0, 1.0);
                        }
                        vec3 gcol = mix(u_gradientColorA, u_gradientColorB, t);
                        float s = clamp(u_gradientStrength, 0.0, 1.0);
                        base = mix(base, base * gcol, s);
                    }
                }

                // Pseudo normal: random + a bit of velocity direction so sparkles react to motion
                vec3 n = normalize(vec3(v_rand.xy * 2.0 - 1.0, v_rand.w * 2.0 - 1.0));
                vec3 vn = normalize(v_vel + vec3(1e-4));
                n = normalize(mix(n, vn, 0.35));
                vec3 l = normalize(u_lightDir);
                float ndl = max(0.0, dot(n, l));
                float specPow = mix(35.0, 160.0, v_rand.y);
                float spec = pow(ndl, specPow);

                // Subtle flicker (very mild, mostly stable)
                float flicker = 0.85 + 0.15 * sin(u_time * 2.2 + v_rand.x * 40.0);
                float sparkle = spec * u_sparkleIntensity * flicker;

                vec3 col = base * u_exposure;
                col += vec3(1.0) * sparkle * 3.5;

                fragColor = vec4(col, alpha);
            }
        `;

        const v = this.compileShader(gl.VERTEX_SHADER, vs);
        const f = this.compileShader(gl.FRAGMENT_SHADER, fs);
        if (!v || !f) return;

        this.gpuProgram = gl.createProgram();
        gl.attachShader(this.gpuProgram, v);
        gl.attachShader(this.gpuProgram, f);
        gl.linkProgram(this.gpuProgram);
        gl.deleteShader(v);
        gl.deleteShader(f);

        if (!gl.getProgramParameter(this.gpuProgram, gl.LINK_STATUS)) {
            console.error('GPU particle program failed to link:', gl.getProgramInfoLog(this.gpuProgram));
            gl.deleteProgram(this.gpuProgram);
            this.gpuProgram = null;
            return;
        }

        this.gpuUniformLocations = {
            posTex: gl.getUniformLocation(this.gpuProgram, 'u_posTex'),
            velTex: gl.getUniformLocation(this.gpuProgram, 'u_velTex'),
            randTex: gl.getUniformLocation(this.gpuProgram, 'u_randTex'),
            texWidth: gl.getUniformLocation(this.gpuProgram, 'u_texWidth'),
            count: gl.getUniformLocation(this.gpuProgram, 'u_count'),
            pointSize: gl.getUniformLocation(this.gpuProgram, 'u_pointSize'),
            resolution: gl.getUniformLocation(this.gpuProgram, 'u_resolution'),
            aspect: gl.getUniformLocation(this.gpuProgram, 'u_aspect'),
            depthScale: gl.getUniformLocation(this.gpuProgram, 'u_depthScale'),
            zoom: gl.getUniformLocation(this.gpuProgram, 'u_zoom'),
            rotX: gl.getUniformLocation(this.gpuProgram, 'u_rotX'),
            rotY: gl.getUniformLocation(this.gpuProgram, 'u_rotY'),
            glowIntensity: gl.getUniformLocation(this.gpuProgram, 'u_glowIntensity'),
            lightDir: gl.getUniformLocation(this.gpuProgram, 'u_lightDir'),
            exposure: gl.getUniformLocation(this.gpuProgram, 'u_exposure'),
            sparkleIntensity: gl.getUniformLocation(this.gpuProgram, 'u_sparkleIntensity'),
	            time: gl.getUniformLocation(this.gpuProgram, 'u_time'),
	            focusEnabled: gl.getUniformLocation(this.gpuProgram, 'u_focusEnabled'),
	            focusCenter: gl.getUniformLocation(this.gpuProgram, 'u_focusCenter'),
	            focusRadius: gl.getUniformLocation(this.gpuProgram, 'u_focusRadius'),
	            focusSoftness: gl.getUniformLocation(this.gpuProgram, 'u_focusSoftness'),
	            focusScatter: gl.getUniformLocation(this.gpuProgram, 'u_focusScatter'),
	            userSize: gl.getUniformLocation(this.gpuProgram, 'u_userSize'),
	            sizeRandom: gl.getUniformLocation(this.gpuProgram, 'u_sizeRandom'),
	            sizeMin: gl.getUniformLocation(this.gpuProgram, 'u_sizeMin'),
	            sizeMax: gl.getUniformLocation(this.gpuProgram, 'u_sizeMax'),
	            opacityRandom: gl.getUniformLocation(this.gpuProgram, 'u_opacityRandom'),
	            opacityMin: gl.getUniformLocation(this.gpuProgram, 'u_opacityMin'),
	            opacityMax: gl.getUniformLocation(this.gpuProgram, 'u_opacityMax'),
	            squaresEnabled: gl.getUniformLocation(this.gpuProgram, 'u_squaresEnabled'),
	            squareRatio: gl.getUniformLocation(this.gpuProgram, 'u_squareRatio'),
            spriteTex: gl.getUniformLocation(this.gpuProgram, 'u_spriteTex'),
            spriteEnabled: gl.getUniformLocation(this.gpuProgram, 'u_spriteEnabled'),
            spriteColorMode: gl.getUniformLocation(this.gpuProgram, 'u_spriteColorMode'),
            spriteRotate: gl.getUniformLocation(this.gpuProgram, 'u_spriteRotate'),
            realColors: gl.getUniformLocation(this.gpuProgram, 'u_realColors'),
            useColorOverride: gl.getUniformLocation(this.gpuProgram, 'u_useColorOverride'),
            colorOverride: gl.getUniformLocation(this.gpuProgram, 'u_colorOverride'),
            useColorTex: gl.getUniformLocation(this.gpuProgram, 'u_useColorTex'),
            colorTexBlend: gl.getUniformLocation(this.gpuProgram, 'u_colorTexBlend'),
            chromatic: gl.getUniformLocation(this.gpuProgram, 'u_chromatic'),
            chromaticShift: gl.getUniformLocation(this.gpuProgram, 'u_chromaticShift'),
            colorTexFrom: gl.getUniformLocation(this.gpuProgram, 'u_colorTexFrom'),
            colorTexTo: gl.getUniformLocation(this.gpuProgram, 'u_colorTexTo'),
            countRatio: gl.getUniformLocation(this.gpuProgram, 'u_countRatio'),
            countSoftness: gl.getUniformLocation(this.gpuProgram, 'u_countSoftness'),

            // Gradient overlay + stable logo-space coords
            targetFrom: gl.getUniformLocation(this.gpuProgram, 'u_targetFrom'),
            targetTo: gl.getUniformLocation(this.gpuProgram, 'u_targetTo'),
            morphT: gl.getUniformLocation(this.gpuProgram, 'u_morphT'),
            gradientEnabled: gl.getUniformLocation(this.gpuProgram, 'u_gradientEnabled'),
            gradientStrength: gl.getUniformLocation(this.gpuProgram, 'u_gradientStrength'),
            gradientDirection: gl.getUniformLocation(this.gpuProgram, 'u_gradientDirection'),
            gradientColorA: gl.getUniformLocation(this.gpuProgram, 'u_gradientColorA'),
            gradientColorB: gl.getUniformLocation(this.gpuProgram, 'u_gradientColorB')
        };

        // Dummy VAO is required in WebGL2 even when using gl_VertexID-only draws.
        this._gpuVAO = gl.createVertexArray();
    }

    /**
     * Create bloom post-processing shader
     */
    createBloomShader() {
        // Bloom is handled via additive blending in the main shader for simplicity
        // Could be extended with multi-pass blur for more realistic bloom
    }

    /**
     * Compile a shader
     */
    compileShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error('Shader compilation error:', gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }

        return shader;
    }

    /**
     * Create framebuffers for post-processing
     */
    createFramebuffers() {
        const gl = this.gl;
        if (!gl) return;

        // Create fullscreen triangle for post passes (layout(location=0) vec2 a_position)
        this._postVAO = gl.createVertexArray();
        gl.bindVertexArray(this._postVAO);
        this._postVBO = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this._postVBO);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1,
            3, -1,
            -1, 3
        ]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        const postVS = `#version 300 es
            layout(location=0) in vec2 a_position;
            out vec2 v_uv;
            void main() {
                v_uv = a_position * 0.5 + 0.5;
                gl_Position = vec4(a_position, 0.0, 1.0);
            }
        `;

        const thresholdFS = `#version 300 es
            precision highp float;
            precision highp sampler2D;
            in vec2 v_uv;
            uniform sampler2D u_scene;
            uniform float u_threshold;
            uniform float u_softKnee;
            out vec4 fragColor;
            void main() {
                vec3 c = texture(u_scene, v_uv).rgb;
                float br = max(c.r, max(c.g, c.b));
                float knee = max(1e-5, u_threshold * u_softKnee);
                float x = clamp((br - u_threshold + knee) / (2.0 * knee), 0.0, 1.0);
                float w = x * x * (3.0 - 2.0 * x);
                fragColor = vec4(c * w, 1.0);
            }
        `;

        const blurFS = `#version 300 es
            precision highp float;
            precision highp sampler2D;
            in vec2 v_uv;
            uniform sampler2D u_input;
            uniform vec2 u_direction;
            out vec4 fragColor;
            void main() {
                vec2 d = u_direction;
                // 5-tap separable gaussian (GPU Gems)
                vec3 sum = texture(u_input, v_uv).rgb * 0.227027;
                sum += texture(u_input, v_uv + d * 1.384615).rgb * 0.316216;
                sum += texture(u_input, v_uv - d * 1.384615).rgb * 0.316216;
                sum += texture(u_input, v_uv + d * 3.230769).rgb * 0.070270;
                sum += texture(u_input, v_uv - d * 3.230769).rgb * 0.070270;
                fragColor = vec4(sum, 1.0);
            }
        `;

        const compositeFS = `#version 300 es
            precision highp float;
            precision highp sampler2D;
            in vec2 v_uv;
            uniform sampler2D u_scene;
            uniform sampler2D u_bloom;
            uniform float u_bloomIntensity;
            out vec4 fragColor;
            void main() {
                vec4 scene = texture(u_scene, v_uv);
                vec3 bloom = texture(u_bloom, v_uv).rgb;
                vec3 col = scene.rgb + bloom * u_bloomIntensity;
                fragColor = vec4(col, scene.a);
            }
        `;

        const progThreshold = this._createProgram(postVS, thresholdFS);
        const progBlur = this._createProgram(postVS, blurFS);
        const progComposite = this._createProgram(postVS, compositeFS);

        this.post = {
            width: 0,
            height: 0,
            bloomW: 0,
            bloomH: 0,

            sceneFBO: gl.createFramebuffer(),
            bloomFBO1: gl.createFramebuffer(),
            bloomFBO2: gl.createFramebuffer(),
            sceneTex: null,
            bloomTex1: null,
            bloomTex2: null,

            progThreshold,
            progBlur,
            progComposite,

            uThreshold: gl.getUniformLocation(progThreshold, 'u_scene'),
            uThreshold_threshold: gl.getUniformLocation(progThreshold, 'u_threshold'),
            uThreshold_softKnee: gl.getUniformLocation(progThreshold, 'u_softKnee'),

            uBlur_input: gl.getUniformLocation(progBlur, 'u_input'),
            uBlur_dir: gl.getUniformLocation(progBlur, 'u_direction'),

            uComp_scene: gl.getUniformLocation(progComposite, 'u_scene'),
            uComp_bloom: gl.getUniformLocation(progComposite, 'u_bloom'),
            uComp_intensity: gl.getUniformLocation(progComposite, 'u_bloomIntensity')
        };
    }

    /**
     * Create a tiny overlay shader for drawing an interactive circle on top of the scene.
     * This must render into the canvas itself so it shows up in video recordings.
     */
    createOverlayProgram() {
        const gl = this.gl;
        if (!gl) return;
        if (!this._postVAO) return; // overlay uses the fullscreen triangle VAO

        const vs = `#version 300 es
            layout(location=0) in vec2 a_position;
            out vec2 v_uv;
            void main() {
                v_uv = a_position * 0.5 + 0.5;
                gl_Position = vec4(a_position, 0.0, 1.0);
            }
        `;

        const fs = `#version 300 es
            precision highp float;
            in vec2 v_uv;

            uniform float u_enabled;
            uniform vec2 u_center;       // world-space center (pre-aspect)
            uniform vec2 u_radius;       // world-space radii (x,y)
            uniform float u_radiusPx;    // CSS pixel radius (for constant ring thickness)
            uniform vec2 u_aspect;       // aspect scale (x,y)
            uniform vec3 u_color;        // rgb 0..1

            out vec4 fragColor;

            void main() {
                if (u_enabled < 0.5) discard;

                // Map uv -> clip coordinates, then undo aspect scaling to compare in world space
                vec2 p = v_uv * 2.0 - 1.0;
                vec2 asp = max(u_aspect, vec2(1e-6));
                vec2 pWorld = p / asp;

                vec2 r = max(u_radius, vec2(1e-5));
                vec2 d = (pWorld - u_center) / r;
                float dist = length(d);
                if (dist > 1.2) discard;

                float fall = clamp(1.0 - dist, 0.0, 1.0);
                float fill = fall * fall;

                // Ring thickness in normalized distance units
                float thickness = clamp(2.0 / max(u_radiusPx, 1.0), 0.01, 0.18);
                float w = fwidth(dist) * 1.5;

                float outer = smoothstep(1.0, 1.0 - w, dist);
                float inner = smoothstep(1.0 - thickness, 1.0 - thickness - w, dist);
                float ring = outer - inner;

                vec3 col = u_color;

                float alpha = ring * 0.85 + fill * 0.12;
                if (alpha < 0.01) discard;

                fragColor = vec4(col, alpha);
            }
        `;

        const v = this.compileShader(gl.VERTEX_SHADER, vs);
        const f = this.compileShader(gl.FRAGMENT_SHADER, fs);
        if (!v || !f) return;

        const program = gl.createProgram();
        gl.attachShader(program, v);
        gl.attachShader(program, f);
        gl.linkProgram(program);
        gl.deleteShader(v);
        gl.deleteShader(f);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('Overlay program failed to link:', gl.getProgramInfoLog(program));
            gl.deleteProgram(program);
            return;
        }

        this._overlayProgram = program;
        this._overlayUniforms = {
            enabled: gl.getUniformLocation(program, 'u_enabled'),
            center: gl.getUniformLocation(program, 'u_center'),
            radius: gl.getUniformLocation(program, 'u_radius'),
            radiusPx: gl.getUniformLocation(program, 'u_radiusPx'),
            aspect: gl.getUniformLocation(program, 'u_aspect'),
            color: gl.getUniformLocation(program, 'u_color')
        };
    }

    /**
     * Update the overlay circle parameters (typically driven by MagnetTool).
     * `circle` can be null/undefined to disable the overlay.
     */
    setOverlayCircle(circle) {
        if (!circle) {
            this._overlayCircle.enabled = false;
            return;
        }

        this._overlayCircle.enabled = !!circle.enabled;
        this._overlayCircle.centerX = Number(circle.centerX) || 0;
        this._overlayCircle.centerY = Number(circle.centerY) || 0;
        this._overlayCircle.radiusClipX = Math.max(1e-6, Number(circle.radiusClipX) || 1e-6);
        this._overlayCircle.radiusClipY = Math.max(1e-6, Number(circle.radiusClipY) || 1e-6);
        this._overlayCircle.radiusPx = Math.max(1, Number(circle.radiusPx) || 140);
        this._overlayCircle.mode = circle.mode ? String(circle.mode) : 'attract';
        if (Array.isArray(circle.color) && circle.color.length === 3) {
            this._overlayCircle.color = circle.color;
        } else if (circle.mode === 'repel') {
            this._overlayCircle.color = [1.0, 0.42, 0.42];
        } else if (circle.mode === 'focus') {
            this._overlayCircle.color = [0.35, 0.74, 1.0];
        } else {
            this._overlayCircle.color = [0.0, 1.0, 0.533];
        }
    }

    _renderOverlayCircle() {
        if (!this._overlayCircle || !this._overlayCircle.enabled) return;
        if (this.fallbackToCanvas2D) return;
        const gl = this.gl;
        if (!gl || !this._overlayProgram || !this._overlayUniforms || !this._postVAO) return;

        gl.useProgram(this._overlayProgram);
        gl.bindVertexArray(this._postVAO);

        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        gl.uniform1f(this._overlayUniforms.enabled, 1.0);
        gl.uniform2f(this._overlayUniforms.center, this._overlayCircle.centerX, this._overlayCircle.centerY);
        gl.uniform2f(this._overlayUniforms.radius, this._overlayCircle.radiusClipX, this._overlayCircle.radiusClipY);
        gl.uniform1f(this._overlayUniforms.radiusPx, this._overlayCircle.radiusPx);
        const aspect = this._getAspectScale();
        gl.uniform2f(this._overlayUniforms.aspect, aspect.x, aspect.y);
        const col = this._overlayCircle.color || [0.0, 1.0, 0.533];
        gl.uniform3f(this._overlayUniforms.color, col[0], col[1], col[2]);

        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
    }

    _createProgram(vsSource, fsSource) {
        const gl = this.gl;
        const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
        const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);
        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('Post program failed to link:', gl.getProgramInfoLog(program));
        }
        return program;
    }

    _ensurePostTargets() {
        const gl = this.gl;
        if (!gl || !this.post) return;

        const w = this.canvas.width | 0;
        const h = this.canvas.height | 0;
        const bw = Math.max(1, (w / 2) | 0);
        const bh = Math.max(1, (h / 2) | 0);
        if (this.post.width === w && this.post.height === h && this.post.bloomW === bw && this.post.bloomH === bh) {
            return;
        }

        // Delete old textures
        if (this.post.sceneTex) gl.deleteTexture(this.post.sceneTex);
        if (this.post.bloomTex1) gl.deleteTexture(this.post.bloomTex1);
        if (this.post.bloomTex2) gl.deleteTexture(this.post.bloomTex2);
        this.post.sceneTex = null;
        this.post.bloomTex1 = null;
        this.post.bloomTex2 = null;

        const checkFBO = (fbo, label) => {
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
            if (status !== gl.FRAMEBUFFER_COMPLETE) {
                console.warn(`Post-process framebuffer incomplete (${label}): 0x${status.toString(16)}`);
                return false;
            }
            return true;
        };

        const buildTargets = (useFloat) => {
            const internal = useFloat ? gl.RGBA16F : gl.RGBA8;
            const type = useFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

            // Some GPUs/browsers can render to half-float but disallow LINEAR filtering without this extension.
            const halfFloatLinear = !!gl.getExtension('OES_texture_half_float_linear');
            const filter = (useFloat && !halfFloatLinear) ? gl.NEAREST : gl.LINEAR;

            const makeTex = (tw, th) => {
                const tex = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.texImage2D(gl.TEXTURE_2D, 0, internal, tw, th, 0, gl.RGBA, type, null);
                gl.bindTexture(gl.TEXTURE_2D, null);
                return tex;
            };

            const sceneTex = makeTex(w, h);
            const bloomTex1 = makeTex(bw, bh);
            const bloomTex2 = makeTex(bw, bh);

            gl.bindFramebuffer(gl.FRAMEBUFFER, this.post.sceneFBO);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTex, 0);
            if (!checkFBO(this.post.sceneFBO, useFloat ? 'scene(16f)' : 'scene(8)')) {
                gl.deleteTexture(sceneTex);
                gl.deleteTexture(bloomTex1);
                gl.deleteTexture(bloomTex2);
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                return null;
            }

            gl.bindFramebuffer(gl.FRAMEBUFFER, this.post.bloomFBO1);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, bloomTex1, 0);
            if (!checkFBO(this.post.bloomFBO1, useFloat ? 'bloom1(16f)' : 'bloom1(8)')) {
                gl.deleteTexture(sceneTex);
                gl.deleteTexture(bloomTex1);
                gl.deleteTexture(bloomTex2);
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                return null;
            }

            gl.bindFramebuffer(gl.FRAMEBUFFER, this.post.bloomFBO2);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, bloomTex2, 0);
            if (!checkFBO(this.post.bloomFBO2, useFloat ? 'bloom2(16f)' : 'bloom2(8)')) {
                gl.deleteTexture(sceneTex);
                gl.deleteTexture(bloomTex1);
                gl.deleteTexture(bloomTex2);
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                return null;
            }

            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            return { sceneTex, bloomTex1, bloomTex2 };
        };

        let created = buildTargets(!!this._supportsFloatColor);
        if (!created && this._supportsFloatColor) {
            // Fallback: use RGBA8 targets so post-processing still works instead of rendering black.
            created = buildTargets(false);
        }

        if (created) {
            this.post.sceneTex = created.sceneTex;
            this.post.bloomTex1 = created.bloomTex1;
            this.post.bloomTex2 = created.bloomTex2;
        } else {
            // Disable post for this size; renderGPU will automatically fall back to direct rendering.
            this.post.sceneTex = null;
            this.post.bloomTex1 = null;
            this.post.bloomTex2 = null;
        }

        this.post.width = w;
        this.post.height = h;
        this.post.bloomW = bw;
        this.post.bloomH = bh;
    }

    /**
     * Resize canvas and update viewport
     */
    resize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = this.canvas.getBoundingClientRect();

        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;

        if (!this.fallbackToCanvas2D && this.gl) {
            this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
            this._ensurePostTargets();
        }
    }

    /**
     * Force an explicit render resolution (used for offline export).
     * This bypasses DOM/CSS sizing and sets the canvas backing store directly.
     */
    resizeTo(width, height) {
        const w = Math.max(1, width | 0);
        const h = Math.max(1, height | 0);
        this.canvas.width = w;
        this.canvas.height = h;
        if (!this.fallbackToCanvas2D && this.gl) {
            this.gl.viewport(0, 0, w, h);
            this._ensurePostTargets();
        }
    }

    /**
     * Convert hex color to RGB array
     */
    hexToRgb(hex) {
        const key = String(hex || '');
        const cached = this._hexToRgbCache.get(key);
        if (cached) return cached;

        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(key);
        const out = result
            ? [
                parseInt(result[1], 16) / 255,
                parseInt(result[2], 16) / 255,
                parseInt(result[3], 16) / 255
            ]
            : [0.83, 0.83, 0.85]; // Default light color

        this._hexToRgbCache.set(key, out);
        return out;
    }

    _ensureCpuArrays(count) {
        const n = Math.max(0, count | 0);
        if (this._cpuArrays && this._cpuArrayCapacity === n) return;
        this._cpuArrayCapacity = n;
        this._cpuArrays = {
            positions: new Float32Array(n * 3),
            colors: new Float32Array(n * 3),
            sizes: new Float32Array(n),
            opacities: new Float32Array(n),
            shapes: new Float32Array(n),
            angles: new Float32Array(n),
            aspects: new Float32Array(n),
            layers: new Float32Array(n)
        };
    }

    _uploadBuffer(buffer, data, usage) {
        const gl = this.gl;
        if (!gl) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        // If the buffer is the same size as last time, avoid reallocating GPU memory.
        const prev = buffer ? this._bufferByteLens.get(buffer) : null;
        if (buffer && prev === data.byteLength) {
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
        } else {
            gl.bufferData(gl.ARRAY_BUFFER, data, usage || gl.DYNAMIC_DRAW);
            if (buffer) this._bufferByteLens.set(buffer, data.byteLength);
        }
    }

    _getAspectScale() {
        const w = Math.max(1, this.canvas.width || 1);
        const h = Math.max(1, this.canvas.height || 1);
        if (w > h) {
            return { x: h / w, y: 1 };
        }
        if (h > w) {
            return { x: 1, y: w / h };
        }
        return { x: 1, y: 1 };
    }

    _ensureSpriteFallbackTexture() {
        const gl = this.gl;
        if (!gl || this._spriteFallbackTex) return this._spriteFallbackTex;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        const data = new Uint8Array([0, 0, 0, 0]);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.bindTexture(gl.TEXTURE_2D, null);
        this._spriteFallbackTex = tex;
        return tex;
    }

    _ensureWhiteTexture() {
        const gl = this.gl;
        if (!gl || this._whiteTex) return this._whiteTex;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        const data = new Uint8Array([255, 255, 255, 255]);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.bindTexture(gl.TEXTURE_2D, null);
        this._whiteTex = tex;
        return tex;
    }

    _getSpriteEntry(sprite) {
        if (!sprite || !sprite.key || !sprite.svg) return null;
        const key = String(sprite.key);
        const svg = String(sprite.svg || '');
        let entry = this._spriteCache.get(key);
        if (!entry || entry.svg !== svg) {
            entry = {
                key,
                svg,
                texture: null,
                canvas: null,
                ready: false,
                loading: false,
                failed: false
            };
            this._spriteCache.set(key, entry);
        }
        if (!entry.ready && !entry.loading && !entry.failed) {
            this._loadSpriteEntry(entry);
        }
        return entry;
    }

    async _loadSpriteEntry(entry) {
        if (!entry || entry.loading) return;
        entry.loading = true;
        try {
            const canvas = await this._rasterizeSvgToCanvas(entry.svg, this._spriteSize);
            entry.canvas = canvas;
            entry.ready = !!canvas;
            if (canvas && this.gl) {
                const gl = this.gl;
                if (entry.texture) gl.deleteTexture(entry.texture);
                const tex = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
                gl.bindTexture(gl.TEXTURE_2D, null);
                entry.texture = tex;
            }
        } catch (e) {
            entry.failed = true;
            console.warn('Failed to rasterize particle icon:', e);
        } finally {
            entry.loading = false;
        }
    }

    async _rasterizeSvgToCanvas(svgString, size) {
        const svg = this._normalizeSvgForRaster(svgString);
        const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        try {
            const img = await this._loadImage(url);
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.clearRect(0, 0, size, size);
                const iw = Math.max(1, img.naturalWidth || img.width || size);
                const ih = Math.max(1, img.naturalHeight || img.height || size);
                const scale = Math.min(size / iw, size / ih);
                const drawW = iw * scale;
                const drawH = ih * scale;
                const dx = (size - drawW) * 0.5;
                const dy = (size - drawH) * 0.5;
                ctx.drawImage(img, dx, dy, drawW, drawH);
            }
            return canvas;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    _normalizeSvgForRaster(svgString) {
        const s = String(svgString || '').trim();
        if (!s) return s;
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(s, 'image/svg+xml');
            const svg = doc.querySelector('svg');
            if (!svg || doc.querySelector('parsererror')) return s;
            const aspect = svg.getAttribute('preserveAspectRatio');
            if (!aspect || String(aspect).trim().toLowerCase().startsWith('none')) {
                svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            }
            return new XMLSerializer().serializeToString(svg);
        } catch (_err) {
            return s;
        }
    }

    _loadImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Failed to rasterize SVG'));
            img.src = url;
        });
    }

    /**
     * Render particles
     */
    render(particles, settings = {}) {
        this.settings = { ...this.settings, ...settings };

        if (this.fallbackToCanvas2D) {
            this.renderCanvas2D(particles);
            return;
        }

        const gl = this.gl;
        // GPU path: render from textures (pos/vel/rand) with post bloom.
        if (particles && !Array.isArray(particles) && particles.mode === 'gpu') {
            this.renderGPU(particles);
            this._renderOverlayCircle();
            return;
        }

        const count = particles.length;

        if (count === 0) {
            // Clear to transparent so the CSS background (grid / custom bg) shows through.
            gl.clearColor(0.0, 0.0, 0.0, 0.0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            this._renderOverlayCircle();
            return;
        }

        // Clear to transparent so the CSS background (grid / custom bg) shows through.
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        // We draw in two passes:
        // - background (layer=1): can use additive glow
        // - logo-space (layer=0): use standard alpha blending so Real Colors stay visible (no white washout)
        let bgCount = 0;
        for (let i = 0; i < count; i++) {
            const p = particles[i];
            const layer = (typeof p._layer === 'number') ? p._layer : (p._isAmbient ? 1.0 : 0.0);
            if (layer >= 0.5) bgCount++;
        }
        const fgCount = count - bgCount;

        // Prepare data arrays (reused to avoid per-frame allocations/GC)
        this._ensureCpuArrays(count);
        const { positions, colors, sizes, opacities, shapes, angles, aspects, layers } = this._cpuArrays;

        // Logo-wide gradient overlay (applied only to logo-space particles: layer < 0.5)
        const gradStrength = Math.max(0, Math.min(1, Number(this.settings.gradientStrength ?? 0)));
        const gradEnabled = !!this.settings.gradientOverlayEnabled && gradStrength > 0;
        const gradW = gradEnabled ? gradStrength : 0;
        const gradDir = String(this.settings.gradientDirection || 'diag');
        const gradA = gradEnabled ? this.hexToRgb(this.settings.gradientColorA) : [1, 1, 1];
        const gradB = gradEnabled ? this.hexToRgb(this.settings.gradientColorB) : [1, 1, 1];

        const clamp01 = (v) => Math.max(0, Math.min(1, v));
        const computeGradT = (x, y) => {
            const xx = Number(x) || 0;
            const yy = Number(y) || 0;
            if (gradDir === 'ltr') return clamp01(xx * 0.5 + 0.5);
            if (gradDir === 'ttb') return clamp01(0.5 - yy * 0.5);
            if (gradDir === 'radial') return clamp01(Math.hypot(xx, yy) / Math.SQRT2);
            // diag: top-left -> bottom-right
            return clamp01((xx - yy + 2.0) * 0.25);
        };

        let bgIndex = 0;
        let fgIndex = bgCount;
        const spriteEntry = this._getSpriteEntry(this.settings.sprite);
        const spriteReady = !!(spriteEntry && spriteEntry.texture);
        const useSprite = !!(this.settings.spriteEnabled && spriteReady);
        const useOriginalSpriteColors = useSprite && String(this.settings.spriteColorMode || 'tint') === 'original';
        for (let i = 0; i < count; i++) {
            const p = particles[i];
            const layer = (typeof p._layer === 'number') ? p._layer : (p._isAmbient ? 1.0 : 0.0);
            const isBg = layer >= 0.5;
            const j = isBg ? bgIndex++ : fgIndex++;

            positions[j * 3] = p.x;
            positions[j * 3 + 1] = p.y;
            positions[j * 3 + 2] = p.z;

            const color = this.hexToRgb(p.displayColor || p.color);
            let m0 = 1.0;
            let m1 = 1.0;
            let m2 = 1.0;
            if (!isBg && gradW > 0) {
                const lx = (typeof p._logoX === 'number')
                    ? p._logoX
                    : ((typeof p.baseX === 'number') ? p.baseX : p.x);
                const ly = (typeof p._logoY === 'number')
                    ? p._logoY
                    : ((typeof p.baseY === 'number') ? p.baseY : p.y);
                const t = computeGradT(lx, ly);

                const g0 = gradA[0] + (gradB[0] - gradA[0]) * t;
                const g1 = gradA[1] + (gradB[1] - gradA[1]) * t;
                const g2 = gradA[2] + (gradB[2] - gradA[2]) * t;

                // Multiply-tint: final = mix(base, base*grad, strength)
                m0 = (1.0 - gradW) + g0 * gradW;
                m1 = (1.0 - gradW) + g1 * gradW;
                m2 = (1.0 - gradW) + g2 * gradW;
            }

            if (useOriginalSpriteColors) {
                colors[j * 3] = m0;
                colors[j * 3 + 1] = m1;
                colors[j * 3 + 2] = m2;
            } else {
                colors[j * 3] = color[0] * m0;
                colors[j * 3 + 1] = color[1] * m1;
                colors[j * 3 + 2] = color[2] * m2;
            }

            sizes[j] = p.size;
            opacities[j] = p.opacity;
            shapes[j] = p._shape || 0;
            angles[j] = p._angle || 0;
            aspects[j] = p._aspect || 1.0;
            layers[j] = isBg ? 1.0 : 0.0;
        }

        // Upload data to buffers
        this._uploadBuffer(this.positionBuffer, positions, gl.DYNAMIC_DRAW);
        this._uploadBuffer(this.colorBuffer, colors, gl.DYNAMIC_DRAW);
        this._uploadBuffer(this.sizeBuffer, sizes, gl.DYNAMIC_DRAW);
        this._uploadBuffer(this.opacityBuffer, opacities, gl.DYNAMIC_DRAW);
        this._uploadBuffer(this.shapeBuffer, shapes, gl.DYNAMIC_DRAW);
        this._uploadBuffer(this.angleBuffer, angles, gl.DYNAMIC_DRAW);
        this._uploadBuffer(this.aspectBuffer, aspects, gl.DYNAMIC_DRAW);
        this._uploadBuffer(this.layerBuffer, layers, gl.DYNAMIC_DRAW);

        // Use program
        gl.useProgram(this.program);

        // Set attributes
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.enableVertexAttribArray(this.attribLocations.position);
        gl.vertexAttribPointer(this.attribLocations.position, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
        gl.enableVertexAttribArray(this.attribLocations.color);
        gl.vertexAttribPointer(this.attribLocations.color, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.sizeBuffer);
        gl.enableVertexAttribArray(this.attribLocations.size);
        gl.vertexAttribPointer(this.attribLocations.size, 1, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.opacityBuffer);
        gl.enableVertexAttribArray(this.attribLocations.opacity);
        gl.vertexAttribPointer(this.attribLocations.opacity, 1, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.shapeBuffer);
        gl.enableVertexAttribArray(this.attribLocations.shape);
        gl.vertexAttribPointer(this.attribLocations.shape, 1, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.angleBuffer);
        gl.enableVertexAttribArray(this.attribLocations.angle);
        gl.vertexAttribPointer(this.attribLocations.angle, 1, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.aspectBuffer);
        gl.enableVertexAttribArray(this.attribLocations.aspect);
        gl.vertexAttribPointer(this.attribLocations.aspect, 1, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.layerBuffer);
        gl.enableVertexAttribArray(this.attribLocations.layer);
        gl.vertexAttribPointer(this.attribLocations.layer, 1, gl.FLOAT, false, 0, 0);

        const minDim = Math.min(this.canvas.width, this.canvas.height);
        const zoom = this.settings.zoom || 1.0;
        const rotX = this.settings.rotationX || 0;
        const rotY = this.settings.rotationY || 0;
        gl.uniform1f(this.uniformLocations.pointSize, minDim * 0.003);
        gl.uniform2f(this.uniformLocations.resolution, this.canvas.width, this.canvas.height);
        const aspect = this._getAspectScale();
        gl.uniform2f(this.uniformLocations.aspect, aspect.x, aspect.y);
        // Allow depthVariance = 0 (0% slider) without falling back to the default.
        const depthScale = (typeof this.settings.depthVariance === 'number')
            ? this.settings.depthVariance
            : 0.5;
        gl.uniform1f(this.uniformLocations.depthScale, depthScale);
        const focusEnabled = this.settings.focusEnabled ? 1.0 : 0.0;
        const focusRadius = Math.max(0, Number(this.settings.focusRadius) || 0);
        const focusSoftRatio = Math.max(0, Math.min(1, Number(this.settings.focusSoftness) || 0));
        const focusSoftness = focusRadius * focusSoftRatio;
        const focusScatterRaw = Number(this.settings.focusScatter);
        const focusScatter = Number.isFinite(focusScatterRaw) ? Math.max(0, focusScatterRaw) : 1;
        const focusCenterX = Number(this.settings.focusCenterX) || 0;
        const focusCenterY = Number(this.settings.focusCenterY) || 0;
        gl.uniform1f(this.uniformLocations.focusEnabled, focusEnabled);
        gl.uniform2f(this.uniformLocations.focusCenter, focusCenterX, focusCenterY);
        gl.uniform1f(this.uniformLocations.focusRadius, focusRadius);
        gl.uniform1f(this.uniformLocations.focusSoftness, focusSoftness);
        gl.uniform1f(this.uniformLocations.focusScatter, focusScatter);
        gl.uniform1f(this.uniformLocations.glowIntensity, this.settings.glowIntensity);
        gl.uniform1f(this.uniformLocations.zoom, zoom);
        gl.uniform1f(this.uniformLocations.rotX, rotX);
        gl.uniform1f(this.uniformLocations.rotY, rotY);
        const spriteTex = useSprite && spriteEntry && spriteEntry.texture
            ? spriteEntry.texture
            : this._ensureSpriteFallbackTexture();
        gl.uniform1f(this.uniformLocations.spriteEnabled, useSprite ? 1.0 : 0.0);
        gl.uniform1f(this.uniformLocations.spriteColorMode, (this.settings.spriteColorMode === 'original') ? 1.0 : 0.0);
        gl.uniform1f(this.uniformLocations.spriteRotate, this.settings.spriteRotate ? 1.0 : 0.0);
        const chromaticEnabled = String(this.settings.colorMode || '') === 'chromatic';
        const chromaShift = Number(this.settings.chromaticShift ?? 0.18) || 0.0;
        gl.uniform1f(this.uniformLocations.chromatic, chromaticEnabled ? 1.0 : 0.0);
        gl.uniform1f(this.uniformLocations.chromaticShift, chromaShift);
        gl.activeTexture(gl.TEXTURE5);
        gl.bindTexture(gl.TEXTURE_2D, spriteTex);
        gl.uniform1i(this.uniformLocations.spriteTex, 5);

        // Draw background first, then logo-space particles.
        const useAdditiveBg = this.settings.glowIntensity > 0.3;
        if (bgCount > 0) {
            if (useAdditiveBg) {
                gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            } else {
                gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            }
            gl.drawArrays(gl.POINTS, 0, bgCount);
        }

        if (fgCount > 0) {
            gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.drawArrays(gl.POINTS, bgCount, fgCount);
        }

        // Overlay must be drawn last so it appears on top of particles and is captured in recordings.
        this._renderOverlayCircle();
    }

    /**
     * Render GPU-driven particles (pos/vel/rand textures) with post bloom.
     * `source` shape:
     * { mode:'gpu', count, texWidth, texHeight, posTex, velTex, randTex, time? }
     */
    renderGPU(source) {
        const gl = this.gl;
        if (!gl || !this.gpuProgram || !this.gpuUniformLocations) return;

        const spriteEntry = this._getSpriteEntry(this.settings.sprite);
        const spriteReady = !!(spriteEntry && spriteEntry.texture);
        const useSprite = !!(this.settings.spriteEnabled && spriteReady);

        const count = Math.max(0, source.count | 0);
        if (count <= 0) {
            gl.clearColor(0.0, 0.0, 0.0, 0.0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            return;
        }

        const interactive = !!(this.settings && this.settings.gpuInteractive);
        const additive = !!(this.settings && this.settings.gpuAdditive);

        this._ensurePostTargets();
        const post = this.post;
        const wantPost = !interactive;
        const hasPost = wantPost && !!post && !!post.sceneTex && !!post.bloomTex1 && !!post.bloomTex2;

        const sceneFBO = hasPost ? post.sceneFBO : null;

        // Update time (for subtle sparkle flicker); exporter can pass an explicit time.
        const tNow = (typeof source.time === 'number') ? source.time : (this._time + 1 / 60);
        this._time = tNow;

        // --- Scene pass ---
        gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.enable(gl.BLEND);
        // Additive blending gives the fbo-like "brighter where denser" feel.
        // For interactive GPU mode we default to additive to emphasize density variation.
        if (additive) {
            gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        } else {
            gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        }

        gl.useProgram(this.gpuProgram);
        gl.bindVertexArray(this._gpuVAO);

        // Bind textures
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, source.posTex);
        gl.uniform1i(this.gpuUniformLocations.posTex, 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, source.velTex);
        gl.uniform1i(this.gpuUniformLocations.velTex, 1);

        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, source.randTex);
        gl.uniform1i(this.gpuUniformLocations.randTex, 2);

        // Target textures for stable logo-space coordinates (used by gradient overlay).
        // Fallback to posTex so the shader always has valid samplers.
        const targetFromTex = source.targetFromTex || source.posTex;
        const targetToTex = source.targetToTex || source.posTex;

        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, targetFromTex);
        gl.uniform1i(this.gpuUniformLocations.targetFrom, 3);

        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, targetToTex);
        gl.uniform1i(this.gpuUniformLocations.targetTo, 4);

        const useColorTex = !!source.useColorTex;
        const colorFallbackTex = this._ensureWhiteTexture();
        const colorFromTex = useColorTex ? (source.colorFromTex || colorFallbackTex) : colorFallbackTex;
        const colorToTex = useColorTex ? (source.colorToTex || source.colorFromTex || colorFallbackTex) : colorFromTex;
        gl.activeTexture(gl.TEXTURE6);
        gl.bindTexture(gl.TEXTURE_2D, colorFromTex);
        gl.uniform1i(this.gpuUniformLocations.colorTexFrom, 6);

        gl.activeTexture(gl.TEXTURE7);
        gl.bindTexture(gl.TEXTURE_2D, colorToTex);
        gl.uniform1i(this.gpuUniformLocations.colorTexTo, 7);

        const spriteTex = useSprite && spriteEntry && spriteEntry.texture
            ? spriteEntry.texture
            : this._ensureSpriteFallbackTexture();
        gl.activeTexture(gl.TEXTURE5);
        gl.bindTexture(gl.TEXTURE_2D, spriteTex);
        gl.uniform1i(this.gpuUniformLocations.spriteTex, 5);

        // Uniforms
        const minDim = Math.min(this.canvas.width, this.canvas.height);
        gl.uniform1f(this.gpuUniformLocations.pointSize, minDim * 0.0022);
        gl.uniform2f(this.gpuUniformLocations.resolution, this.canvas.width, this.canvas.height);
        const aspect = this._getAspectScale();
        gl.uniform2f(this.gpuUniformLocations.aspect, aspect.x, aspect.y);
        const depthScale = (typeof this.settings.depthVariance === 'number') ? this.settings.depthVariance : 0.5;
        gl.uniform1f(this.gpuUniformLocations.depthScale, depthScale);
        const focusEnabled = this.settings.focusEnabled ? 1.0 : 0.0;
        const focusRadius = Math.max(0, Number(this.settings.focusRadius) || 0);
        const focusSoftRatio = Math.max(0, Math.min(1, Number(this.settings.focusSoftness) || 0));
        const focusSoftness = focusRadius * focusSoftRatio;
        const focusScatterRaw = Number(this.settings.focusScatter);
        const focusScatter = Number.isFinite(focusScatterRaw) ? Math.max(0, focusScatterRaw) : 1;
        const focusCenterX = Number(this.settings.focusCenterX) || 0;
        const focusCenterY = Number(this.settings.focusCenterY) || 0;
        gl.uniform1f(this.gpuUniformLocations.focusEnabled, focusEnabled);
        gl.uniform2f(this.gpuUniformLocations.focusCenter, focusCenterX, focusCenterY);
        gl.uniform1f(this.gpuUniformLocations.focusRadius, focusRadius);
        gl.uniform1f(this.gpuUniformLocations.focusSoftness, focusSoftness);
        gl.uniform1f(this.gpuUniformLocations.focusScatter, focusScatter);
        gl.uniform1f(this.gpuUniformLocations.zoom, this.settings.zoom || 1.0);
        gl.uniform1f(this.gpuUniformLocations.rotX, this.settings.rotationX || 0);
        gl.uniform1f(this.gpuUniformLocations.rotY, this.settings.rotationY || 0);
        gl.uniform1f(this.gpuUniformLocations.glowIntensity, this.settings.glowIntensity ?? 0.4);
        gl.uniform1f(this.gpuUniformLocations.exposure, 1.0);
        gl.uniform1f(this.gpuUniformLocations.sparkleIntensity, 0.65 + (this.settings.glowIntensity ?? 0.4) * 0.35);
        gl.uniform1f(this.gpuUniformLocations.time, tNow);
        // Cinematic key light
        gl.uniform3f(this.gpuUniformLocations.lightDir, 0.35, 0.75, 0.55);

	        // UI-driven GPU look controls (these make the control panel meaningful at high densities)
	        gl.uniform1f(this.gpuUniformLocations.userSize, Number(this.settings.userSize ?? 2.0) || 2.0);
	        gl.uniform1f(this.gpuUniformLocations.sizeRandom, Math.max(0, Math.min(1, Number(this.settings.sizeRandom ?? 1.0) || 0)));
	        gl.uniform1f(this.gpuUniformLocations.sizeMin, Math.max(0.05, Number(this.settings.sizeMin ?? 0.8) || 0.05));
	        gl.uniform1f(this.gpuUniformLocations.sizeMax, Math.max(0.05, Number(this.settings.sizeMax ?? 1.2) || 0.05));
	        gl.uniform1f(this.gpuUniformLocations.opacityRandom, Math.max(0, Math.min(1, Number(this.settings.opacityRandom ?? 1.0) || 0)));
	        gl.uniform1f(this.gpuUniformLocations.opacityMin, Math.max(0, Math.min(1, Number(this.settings.opacityMin ?? 0.68) || 0)));
	        gl.uniform1f(this.gpuUniformLocations.opacityMax, Math.max(0, Math.min(1, Number(this.settings.opacityMax ?? 0.82) || 0)));
	        gl.uniform1f(this.gpuUniformLocations.squaresEnabled, this.settings.squaresEnabled ? 1.0 : 0.0);
	        gl.uniform1f(this.gpuUniformLocations.squareRatio, Math.max(0, Math.min(1, Number(this.settings.squareRatio ?? 0.25) || 0)));
        gl.uniform1f(this.gpuUniformLocations.spriteEnabled, useSprite ? 1.0 : 0.0);
        gl.uniform1f(this.gpuUniformLocations.spriteColorMode, (this.settings.spriteColorMode === 'original') ? 1.0 : 0.0);
        gl.uniform1f(this.gpuUniformLocations.spriteRotate, this.settings.spriteRotate ? 1.0 : 0.0);
	        gl.uniform1f(this.gpuUniformLocations.realColors, this.settings.realColors ? 1.0 : 0.0);
        gl.uniform1f(this.gpuUniformLocations.useColorOverride, this.settings.useColorOverride ? 1.0 : 0.0);
        gl.uniform1f(this.gpuUniformLocations.useColorTex, useColorTex ? 1.0 : 0.0);
        const colorTexBlend = Number.isFinite(this.settings.colorTexBlend)
            ? Math.max(0, Math.min(1, this.settings.colorTexBlend))
            : (useColorTex ? 1.0 : 0.0);
        gl.uniform1f(this.gpuUniformLocations.colorTexBlend, colorTexBlend);
        const chromaticEnabled = String(this.settings.colorMode || '') === 'chromatic';
        const chromaShift = Number(this.settings.chromaticShift ?? 0.18) || 0.0;
        gl.uniform1f(this.gpuUniformLocations.chromatic, chromaticEnabled ? 1.0 : 0.0);
        gl.uniform1f(this.gpuUniformLocations.chromaticShift, chromaShift);
        const countRatio = Number.isFinite(this.settings.countRatio)
            ? Math.max(0, Math.min(1, this.settings.countRatio))
            : 1.0;
        const countSoftness = Number.isFinite(this.settings.countSoftness)
            ? Math.max(0.001, Math.min(0.5, this.settings.countSoftness))
            : 0.08;
        gl.uniform1f(this.gpuUniformLocations.countRatio, countRatio);
        gl.uniform1f(this.gpuUniformLocations.countSoftness, countSoftness);
        const c = Array.isArray(this.settings.colorOverrideRgb) ? this.settings.colorOverrideRgb : null;
        const cr = (c && c.length === 3) ? c : [1.0, 1.0, 1.0];
        gl.uniform3f(this.gpuUniformLocations.colorOverride, cr[0], cr[1], cr[2]);

        // Gradient overlay controls
        const gradStrength = Math.max(0, Math.min(1, Number(this.settings.gradientStrength ?? 0)));
        const gradEnabled = !!this.settings.gradientOverlayEnabled && gradStrength > 0;
        gl.uniform1f(this.gpuUniformLocations.gradientEnabled, gradEnabled ? 1.0 : 0.0);
        gl.uniform1f(this.gpuUniformLocations.gradientStrength, gradEnabled ? gradStrength : 0.0);

        const dir = String(this.settings.gradientDirection || 'diag');
        let dirCode = 2.0; // diag
        if (dir === 'ltr') dirCode = 0.0;
        else if (dir === 'ttb') dirCode = 1.0;
        else if (dir === 'radial') dirCode = 3.0;
        gl.uniform1f(this.gpuUniformLocations.gradientDirection, dirCode);

        const ga = this.hexToRgb(this.settings.gradientColorA);
        const gb = this.hexToRgb(this.settings.gradientColorB);
        gl.uniform3f(this.gpuUniformLocations.gradientColorA, ga[0], ga[1], ga[2]);
        gl.uniform3f(this.gpuUniformLocations.gradientColorB, gb[0], gb[1], gb[2]);

        // Morph blend (for stable logo-space coords in shader)
        gl.uniform1f(this.gpuUniformLocations.morphT, Math.max(0, Math.min(1, Number(this.settings.morphT ?? 1))));

        gl.uniform1i(this.gpuUniformLocations.texWidth, source.texWidth | 0);
        gl.uniform1i(this.gpuUniformLocations.count, count);

        gl.drawArrays(gl.POINTS, 0, count);
        gl.bindVertexArray(null);

        // If something went wrong at the WebGL API level (common on some drivers when using float textures),
        // throw so the caller can fall back to CPU mode instead of leaving a blank canvas.
        if (interactive) {
            const err = gl.getError();
            if (err !== gl.NO_ERROR) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                throw new Error(`WebGL error during GPU render: 0x${err.toString(16)}`);
            }
        }

        if (!hasPost) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            return;
        }

        // --- Post: extract highlights ---
        gl.disable(gl.BLEND);
        gl.bindVertexArray(this._postVAO);

        gl.bindFramebuffer(gl.FRAMEBUFFER, post.bloomFBO1);
        gl.viewport(0, 0, post.bloomW, post.bloomH);
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(post.progThreshold);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, post.sceneTex);
        gl.uniform1i(post.uThreshold, 0);
        gl.uniform1f(post.uThreshold_threshold, 1.05);
        gl.uniform1f(post.uThreshold_softKnee, 0.6);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // --- Post: blur horizontal ---
        gl.bindFramebuffer(gl.FRAMEBUFFER, post.bloomFBO2);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(post.progBlur);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, post.bloomTex1);
        gl.uniform1i(post.uBlur_input, 0);
        gl.uniform2f(post.uBlur_dir, 1.0 / post.bloomW, 0.0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // --- Post: blur vertical ---
        gl.bindFramebuffer(gl.FRAMEBUFFER, post.bloomFBO1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, post.bloomTex2);
        gl.uniform1i(post.uBlur_input, 0);
        gl.uniform2f(post.uBlur_dir, 0.0, 1.0 / post.bloomH);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // --- Post: composite to screen ---
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(post.progComposite);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, post.sceneTex);
        gl.uniform1i(post.uComp_scene, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, post.bloomTex1);
        gl.uniform1i(post.uComp_bloom, 1);
        gl.uniform1f(post.uComp_intensity, 0.85 + (this.settings.glowIntensity ?? 0.4) * 0.65);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.bindVertexArray(null);
        gl.enable(gl.BLEND);
    }

    /**
     * Canvas2D fallback renderer
     */
    renderCanvas2D(particles) {
        const ctx = this.canvas.getContext('2d');
        const { width, height } = this.canvas;
        const aspect = this._getAspectScale();
        const ax = aspect.x;
        const ay = aspect.y;

        // Clear to transparent so the CSS background (grid / custom bg) shows through.
        ctx.clearRect(0, 0, width, height);

        // Logo-wide gradient overlay (Canvas2D fallback)
        const gradStrength = Math.max(0, Math.min(1, Number(this.settings.gradientStrength ?? 0)));
        const gradEnabled = !!this.settings.gradientOverlayEnabled && gradStrength > 0;
        const gradW = gradEnabled ? gradStrength : 0;
        const gradDir = String(this.settings.gradientDirection || 'diag');
        const gradA = gradEnabled ? this.hexToRgb(this.settings.gradientColorA) : [1, 1, 1];
        const gradB = gradEnabled ? this.hexToRgb(this.settings.gradientColorB) : [1, 1, 1];

        const spriteEntry = this._getSpriteEntry(this.settings.sprite);
        const spriteCanvas = spriteEntry && spriteEntry.canvas ? spriteEntry.canvas : null;
        const useSprite = !!(this.settings.spriteEnabled && spriteCanvas);
        const useOriginalSpriteColors = useSprite && String(this.settings.spriteColorMode || 'tint') === 'original';
        const rotateSprite = !!this.settings.spriteRotate;
        const chroma = String(this.settings.colorMode || '') === 'chromatic';

        const clamp01 = (v) => Math.max(0, Math.min(1, v));
        const computeGradT = (x, y) => {
            const xx = Number(x) || 0;
            const yy = Number(y) || 0;
            if (gradDir === 'ltr') return clamp01(xx * 0.5 + 0.5);
            if (gradDir === 'ttb') return clamp01(0.5 - yy * 0.5);
            if (gradDir === 'radial') return clamp01(Math.hypot(xx, yy) / Math.SQRT2);
            return clamp01((xx - yy + 2.0) * 0.25);
        };

        // Draw particles
        for (const p of particles) {
            const x = ((p.x * ax) * 0.5 + 0.5) * width;
            const y = (1 - ((p.y * ay) * 0.5 + 0.5)) * height;
            const size = p.size * 2;
            const opacity = p.opacity;
            const baseHex = chroma ? '#ffffff' : (p.displayColor || p.color);
            const layer = (typeof p._layer === 'number') ? p._layer : (p._isAmbient ? 1.0 : 0.0);
            const isBg = layer >= 0.5;

            let fillStyle = baseHex;
            if (!isBg && gradW > 0) {
                const base = this.hexToRgb(baseHex);
                const lx = (typeof p._logoX === 'number')
                    ? p._logoX
                    : ((typeof p.baseX === 'number') ? p.baseX : p.x);
                const ly = (typeof p._logoY === 'number')
                    ? p._logoY
                    : ((typeof p.baseY === 'number') ? p.baseY : p.y);
                const t = computeGradT(lx, ly);

                const g0 = gradA[0] + (gradB[0] - gradA[0]) * t;
                const g1 = gradA[1] + (gradB[1] - gradA[1]) * t;
                const g2 = gradA[2] + (gradB[2] - gradA[2]) * t;
                const m0 = (1.0 - gradW) + g0 * gradW;
                const m1 = (1.0 - gradW) + g1 * gradW;
                const m2 = (1.0 - gradW) + g2 * gradW;

                const r = Math.round(Math.max(0, Math.min(1, base[0] * m0)) * 255);
                const g = Math.round(Math.max(0, Math.min(1, base[1] * m1)) * 255);
                const b = Math.round(Math.max(0, Math.min(1, base[2] * m2)) * 255);
                fillStyle = `rgb(${r},${g},${b})`;
            }

            if (useSprite && spriteCanvas) {
                const side = size * 2;
                ctx.save();
                ctx.translate(x, y);
                if (rotateSprite) {
                    ctx.rotate(p._angle || 0);
                }
                ctx.globalAlpha = opacity;
                ctx.drawImage(spriteCanvas, -side / 2, -side / 2, side, side);
                if (!useOriginalSpriteColors) {
                    ctx.globalCompositeOperation = 'source-in';
                    ctx.fillStyle = fillStyle;
                    ctx.fillRect(-side / 2, -side / 2, side, side);
                }
                ctx.restore();
                ctx.globalCompositeOperation = 'source-over';
                continue;
            }

            ctx.fillStyle = fillStyle;
            ctx.globalAlpha = opacity;
            if ((p._shape || 0) >= 0.5) {
                // Square (simple, non-rotated fallback)
                const side = size * 2;
                ctx.fillRect(x - side / 2, y - side / 2, side, side);
            } else {
                ctx.beginPath();
                ctx.arc(x, y, size, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Overlay circle (MagnetTool) for Canvas2D fallback
        if (this._overlayCircle && this._overlayCircle.enabled) {
            const c = this._overlayCircle;
            const cx = ((c.centerX * ax) * 0.5 + 0.5) * width;
            const cy = (1 - ((c.centerY * ay) * 0.5 + 0.5)) * height;
            const rx = c.radiusClipX * ax * width * 0.5;
            const ry = c.radiusClipY * ay * height * 0.5;
            const r = Math.max(1, Math.min(rx, ry));

            ctx.save();
            ctx.globalAlpha = 0.85;
            ctx.lineWidth = Math.max(1, Math.min(4, r * 0.02));
            const overlayColor = (Array.isArray(c.color) && c.color.length === 3)
                ? c.color
                : (c.mode === 'repel')
                    ? [1.0, 0.42, 0.42]
                    : (c.mode === 'focus')
                        ? [0.35, 0.74, 1.0]
                        : [0.0, 1.0, 0.533];
            const overlayCss = `rgb(${Math.round(overlayColor[0] * 255)},${Math.round(overlayColor[1] * 255)},${Math.round(overlayColor[2] * 255)})`;
            ctx.strokeStyle = overlayCss;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.stroke();

            ctx.globalAlpha = 0.12;
            ctx.fillStyle = overlayCss;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }

        ctx.globalAlpha = 1;
    }

    /**
     * Export canvas as image
     */
    exportImage(format = 'png', scale = 2) {
        // Create high-res canvas
        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = this.canvas.width * scale;
        exportCanvas.height = this.canvas.height * scale;

        const ctx = exportCanvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.drawImage(this.canvas, 0, 0);

        const mimeType = format === 'png' ? 'image/png' :
            format === 'webp' ? 'image/webp' : 'image/jpeg';

        return exportCanvas.toDataURL(mimeType, 0.95);
    }

    /**
     * Update settings
     */
    updateSettings(settings) {
        this.settings = { ...this.settings, ...settings };
    }

    /**
     * Cleanup
     */
    dispose() {
        if (this.gl) {
            const gl = this.gl;
            gl.deleteBuffer(this.positionBuffer);
            gl.deleteBuffer(this.colorBuffer);
            gl.deleteBuffer(this.sizeBuffer);
            gl.deleteBuffer(this.opacityBuffer);
            gl.deleteBuffer(this.shapeBuffer);
            gl.deleteBuffer(this.angleBuffer);
            gl.deleteBuffer(this.aspectBuffer);
            gl.deleteBuffer(this.layerBuffer);
            gl.deleteProgram(this.program);

            if (this._overlayProgram) gl.deleteProgram(this._overlayProgram);

            if (this.gpuProgram) gl.deleteProgram(this.gpuProgram);
            if (this._gpuVAO) gl.deleteVertexArray(this._gpuVAO);

            if (this._postVBO) gl.deleteBuffer(this._postVBO);
            if (this._postVAO) gl.deleteVertexArray(this._postVAO);

            if (this.post) {
                if (this.post.sceneTex) gl.deleteTexture(this.post.sceneTex);
                if (this.post.bloomTex1) gl.deleteTexture(this.post.bloomTex1);
                if (this.post.bloomTex2) gl.deleteTexture(this.post.bloomTex2);
                if (this.post.sceneFBO) gl.deleteFramebuffer(this.post.sceneFBO);
                if (this.post.bloomFBO1) gl.deleteFramebuffer(this.post.bloomFBO1);
                if (this.post.bloomFBO2) gl.deleteFramebuffer(this.post.bloomFBO2);
                if (this.post.progThreshold) gl.deleteProgram(this.post.progThreshold);
                if (this.post.progBlur) gl.deleteProgram(this.post.progBlur);
                if (this.post.progComposite) gl.deleteProgram(this.post.progComposite);
            }

            if (this._spriteFallbackTex) gl.deleteTexture(this._spriteFallbackTex);
            if (this._whiteTex) gl.deleteTexture(this._whiteTex);
            if (this._spriteCache && this._spriteCache.size) {
                for (const entry of this._spriteCache.values()) {
                    if (entry && entry.texture) gl.deleteTexture(entry.texture);
                }
                this._spriteCache.clear();
            }
        }
    }
}
