/**
 * gl-utils.js
 * Small WebGL2 helpers (no dependencies).
 */
export function getWebGL2Context(canvas, opts = {}) {
    const gl = canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: false,
        antialias: true,
        preserveDrawingBuffer: true,
        ...opts
    });
    return gl;
}

export function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader) || 'Unknown shader compile error';
        gl.deleteShader(shader);
        throw new Error(log);
    }
    return shader;
}

export function createProgram(gl, vertexSource, fragmentSource) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program) || 'Unknown program link error';
        gl.deleteProgram(program);
        throw new Error(log);
    }
    return program;
}

export function createTexture2D(gl, {
    width,
    height,
    internalFormat,
    format,
    type,
    data = null,
    minFilter = gl.NEAREST,
    magFilter = gl.NEAREST,
    wrapS = gl.CLAMP_TO_EDGE,
    wrapT = gl.CLAMP_TO_EDGE
}) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        internalFormat,
        width,
        height,
        0,
        format,
        type,
        data
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
}

export function createFramebuffer(gl) {
    return gl.createFramebuffer();
}

export function bindFramebufferWithAttachments(gl, fbo, attachments) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    for (const a of attachments) {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, a.attachment, gl.TEXTURE_2D, a.texture, 0);
    }
}

export function assertFramebufferComplete(gl, label = 'framebuffer') {
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`WebGL framebuffer incomplete (${label}): 0x${status.toString(16)}`);
    }
}

export function ensureColorBufferFloat(gl) {
    // Required for rendering to RGBA16F/RGBA32F in WebGL2.
    const ext = gl.getExtension('EXT_color_buffer_float');
    return !!ext;
}

export function createFullscreenTriangle(gl) {
    // Fullscreen triangle positions
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,
        3, -1,
        -1, 3
    ]), gl.STATIC_DRAW);

    // attribute location 0 by convention in our shaders (a_position)
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    return { vao, vbo };
}

export function safeDelete(gl, { program, textures = [], framebuffers = [], buffers = [], vaos = [] } = {}) {
    if (program) gl.deleteProgram(program);
    for (const t of textures) gl.deleteTexture(t);
    for (const f of framebuffers) gl.deleteFramebuffer(f);
    for (const b of buffers) gl.deleteBuffer(b);
    for (const v of vaos) gl.deleteVertexArray(v);
}


