/**
 * video-exporter.js
 * Offline deterministic export helpers:
 * - WebCodecs -> WebM (VP9/VP8) via a tiny EBML muxer.
 * - PNG sequence ZIP fallback (store-only zip).
 */

function getWebGLContext(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    return canvas.getContext('webgl2') || canvas.getContext('webgl');
}

function finishGpu(gl) {
    if (!gl || typeof gl.finish !== 'function') return;
    try {
        gl.finish();
    } catch (_) {
        // Ignore GPU completion errors (context may be lost).
    }
}

export async function exportWebMVideo({
    canvas,
    width,
    height,
    fps = 30,
    frameCount,
    renderFrame,
    codec = 'vp09.00.10.08',
    bitrate = 25_000_000,
    clusterMaxMs = 3000
}) {
    if (typeof VideoEncoder === 'undefined') {
        throw new Error('WebCodecs VideoEncoder is not supported in this browser.');
    }
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    const fr = Math.max(1, fps | 0);
    const n = Math.max(1, frameCount | 0);
    if (!canvas || canvas.width === 0 || canvas.height === 0) {
        throw new Error('Canvas is not ready for video export.');
    }
    const gl = getWebGLContext(canvas);

    const supported = await VideoEncoder.isConfigSupported({
        codec,
        width: w,
        height: h,
        bitrate,
        framerate: fr
    });
    if (!supported.supported) {
        throw new Error(`VideoEncoder config not supported for codec "${codec}".`);
    }

    const muxer = new WebMMuxer({
        width: w,
        height: h,
        fps: fr,
        codecId: /^vp0?8/i.test(String(codec || '')) ? 'V_VP8' : 'V_VP9',
        clusterMaxMs
    });

    let encoderError = null;
    const encoder = new VideoEncoder({
        output: (chunk) => {
            try {
                muxer.addChunk(chunk);
            } catch (e) {
                encoderError = e;
            }
        },
        error: (e) => {
            encoderError = e;
        }
    });

    encoder.configure({
        codec,
        width: w,
        height: h,
        bitrate,
        framerate: fr
    });

    const usPerFrame = Math.round(1_000_000 / fr);

    for (let i = 0; i < n; i++) {
        // Deterministic offline render
        // eslint-disable-next-line no-await-in-loop
        await renderFrame(i, i / fr, 1 / fr);

        finishGpu(gl);
        const timestamp = i * usPerFrame;
        let frame;
        try {
            frame = new VideoFrame(canvas, { timestamp });
        } catch (e) {
            throw new Error(`Failed to create VideoFrame: ${e && e.message ? e.message : e}`);
        }
        const keyEvery = Math.max(1, Math.round(fr * 2)); // keyframe ~every 2s
        try {
            encoder.encode(frame, { keyFrame: i === 0 || (i % keyEvery === 0) });
        } finally {
            frame.close();
        }

        // Backpressure
        if (encoder.encodeQueueSize > 6) {
            // eslint-disable-next-line no-await-in-loop
            await encoder.flush();
        }

        if (encoderError) throw encoderError;
    }

    await encoder.flush();
    if (encoderError) throw encoderError;
    encoder.close();

    return muxer.finalize();
}

export async function exportPngZip({
    canvas,
    frameCount,
    renderFrame,
    filePrefix = 'frame'
}) {
    const n = Math.max(1, frameCount | 0);
    const zip = new ZipWriter();
    if (!canvas || canvas.width === 0 || canvas.height === 0) {
        throw new Error('Canvas is not ready for PNG export.');
    }
    const gl = getWebGLContext(canvas);

    for (let i = 0; i < n; i++) {
        // eslint-disable-next-line no-await-in-loop
        await renderFrame(i);

        finishGpu(gl);
        // eslint-disable-next-line no-await-in-loop
        const blob = await canvasToBlob(canvas, 'image/png');
        // eslint-disable-next-line no-await-in-loop
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const name = `${filePrefix}_${String(i).padStart(6, '0')}.png`;
        zip.addFile(name, bytes);
    }

    return zip.finalize();
}

function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((b) => {
            if (!b) return reject(new Error('Failed to encode canvas frame.'));
            resolve(b);
        }, type, quality);
    });
}

/**
 * Minimal WebM muxer for VP8/VP9 (no audio).
 * Uses:
 * - TimecodeScale = 1ms (1,000,000 ns)
 * - SimpleBlock in Clusters
 */
class WebMMuxer {
    constructor({ width, height, fps, codecId = 'V_VP9', clusterMaxMs = 3000 } = {}) {
        this.width = width | 0;
        this.height = height | 0;
        this.fps = fps | 0;
        this.codecId = codecId;
        this.clusterMaxMs = Math.max(250, clusterMaxMs | 0);

        this.timecodeScaleNs = 1_000_000; // 1ms
        this._parts = [];

        // Cluster state
        this._clusterTimecodeMs = null;
        this._clusterParts = [];
        this._clusterSize = 0;

        this._writeHeader();
    }

    addChunk(chunk) {
        // WebCodecs timestamps are in microseconds
        const timeMs = Math.round((chunk.timestamp || 0) / 1000);
        const isKey = chunk.type === 'key';

        if (this._clusterTimecodeMs == null) {
            this._startCluster(timeMs);
        } else if (timeMs - this._clusterTimecodeMs >= this.clusterMaxMs) {
            this._flushCluster();
            this._startCluster(timeMs);
        } else if (isKey && (timeMs - this._clusterTimecodeMs) > 1000 && this._clusterParts.length > 1) {
            // Start a new cluster on distant keyframes for better seeking
            this._flushCluster();
            this._startCluster(timeMs);
        }

        const rel = timeMs - this._clusterTimecodeMs;
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);

        const block = makeSimpleBlock({
            trackNumber: 1,
            timecode: rel,
            keyframe: isKey,
            frame: data
        });

        this._clusterParts.push(block);
        this._clusterSize += block.length;
    }

    finalize() {
        this._flushCluster();
        return new Blob(this._parts, { type: 'video/webm' });
    }

    _writeHeader() {
        // EBML header
        this._parts.push(
            ebmlElement(EBML, concatParts([
                ebmlElement(EBMLVersion, uInt(1)),
                ebmlElement(EBMLReadVersion, uInt(1)),
                ebmlElement(EBMLMaxIDLength, uInt(4)),
                ebmlElement(EBMLMaxSizeLength, uInt(8)),
                ebmlElement(DocType, str('webm')),
                ebmlElement(DocTypeVersion, uInt(2)),
                ebmlElement(DocTypeReadVersion, uInt(2))
            ]))
        );

        // Segment (unknown size)
        this._parts.push(Segment);
        this._parts.push(UNKNOWN_SIZE_8);

        // Info
        this._parts.push(
            ebmlElement(Info, concatParts([
                ebmlElement(TimecodeScale, uInt(this.timecodeScaleNs)),
                ebmlElement(MuxingApp, str('ParticleForge')),
                ebmlElement(WritingApp, str('ParticleForge'))
            ]))
        );

        // Tracks (single video track)
        const defaultDurationNs = Math.round(1_000_000_000 / Math.max(1, this.fps));
        const trackEntry = ebmlElement(TrackEntry, concatParts([
            ebmlElement(TrackNumber, uInt(1)),
            ebmlElement(TrackUID, uInt(1)),
            ebmlElement(TrackType, uInt(1)), // video
            ebmlElement(CodecID, str(this.codecId)),
            ebmlElement(DefaultDuration, uInt(defaultDurationNs)),
            ebmlElement(Video, concatParts([
                ebmlElement(PixelWidth, uInt(this.width)),
                ebmlElement(PixelHeight, uInt(this.height))
            ]))
        ]));

        this._parts.push(ebmlElement(Tracks, trackEntry));
    }

    _startCluster(timecodeMs) {
        this._clusterTimecodeMs = timecodeMs | 0;
        const timecodeEl = ebmlElement(ClusterTimecode, uInt(this._clusterTimecodeMs));
        this._clusterParts = [timecodeEl];
        this._clusterSize = timecodeEl.length;
    }

    _flushCluster() {
        if (this._clusterTimecodeMs == null) return;
        if (!this._clusterParts.length) return;

        const size = this._clusterSize;
        this._parts.push(Cluster);
        this._parts.push(vint(size));
        for (const p of this._clusterParts) this._parts.push(p);

        this._clusterTimecodeMs = null;
        this._clusterParts = [];
        this._clusterSize = 0;
    }
}

// --- EBML helpers ---

function ebmlElement(idBytes, dataBytes) {
    const sizeBytes = vint(dataBytes.length);
    return concatParts([idBytes, sizeBytes, dataBytes]);
}

function concatParts(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}

function str(s) {
    return new TextEncoder().encode(String(s));
}

function uInt(value) {
    // Minimal big-endian unsigned integer encoding
    let v = BigInt(value);
    if (v < 0n) v = 0n;
    const bytes = [];
    while (v > 0n) {
        bytes.push(Number(v & 0xFFn));
        v >>= 8n;
    }
    if (bytes.length === 0) bytes.push(0);
    bytes.reverse();
    return new Uint8Array(bytes);
}

function vint(value) {
    const v = Math.max(0, Number(value) || 0);
    for (let len = 1; len <= 8; len++) {
        const max = Math.pow(2, 7 * len) - 2; // reserve all-ones for unknown
        if (v <= max) return vintWithLength(v, len);
    }
    return vintWithLength(v, 8);
}

function vintWithLength(value, len) {
    let v = value >>> 0;
    const out = new Uint8Array(len);
    for (let i = len - 1; i >= 1; i--) {
        out[i] = v & 0xFF;
        v >>>= 8;
    }
    const marker = 1 << (8 - len);
    out[0] = marker | (v & (marker - 1));
    return out;
}

function makeSimpleBlock({ trackNumber, timecode, keyframe, frame }) {
    const trackVint = vint(trackNumber);
    const tc = new Uint8Array(2);
    const t = (timecode << 16) >> 16; // int16
    tc[0] = (t >> 8) & 0xFF;
    tc[1] = t & 0xFF;
    const flags = new Uint8Array([keyframe ? 0x80 : 0x00]);
    const payload = concatParts([trackVint, tc, flags, frame]);
    return ebmlElement(SimpleBlock, payload);
}

// EBML IDs
const EBML = u8(0x1A, 0x45, 0xDF, 0xA3);
const EBMLVersion = u8(0x42, 0x86);
const EBMLReadVersion = u8(0x42, 0xF7);
const EBMLMaxIDLength = u8(0x42, 0xF2);
const EBMLMaxSizeLength = u8(0x42, 0xF3);
const DocType = u8(0x42, 0x82);
const DocTypeVersion = u8(0x42, 0x87);
const DocTypeReadVersion = u8(0x42, 0x85);

const Segment = u8(0x18, 0x53, 0x80, 0x67);
const Info = u8(0x15, 0x49, 0xA9, 0x66);
const TimecodeScale = u8(0x2A, 0xD7, 0xB1);
const MuxingApp = u8(0x4D, 0x80);
const WritingApp = u8(0x57, 0x41);
const DefaultDuration = u8(0x23, 0xE3, 0x83);

const Tracks = u8(0x16, 0x54, 0xAE, 0x6B);
const TrackEntry = u8(0xAE);
const TrackNumber = u8(0xD7);
const TrackUID = u8(0x73, 0xC5);
const TrackType = u8(0x83);
const CodecID = u8(0x86);
const Video = u8(0xE0);
const PixelWidth = u8(0xB0);
const PixelHeight = u8(0xBA);

const Cluster = u8(0x1F, 0x43, 0xB6, 0x75);
const ClusterTimecode = u8(0xE7);
const SimpleBlock = u8(0xA3);

// Unknown size (8 bytes)
const UNKNOWN_SIZE_8 = u8(0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF);

function u8(...bytes) {
    return new Uint8Array(bytes);
}

// --- ZIP fallback ---

class ZipWriter {
    constructor() {
        this._files = [];
        this._offset = 0;
    }

    addFile(name, data) {
        const filename = new TextEncoder().encode(name);
        const crc = crc32(data);
        const localHeader = makeLocalFileHeader({
            filename,
            crc,
            size: data.length,
            offset: this._offset
        });
        this._files.push({ filename, data, crc, size: data.length, localHeaderOffset: this._offset });
        this._offset += localHeader.length + data.length;
        this._files[this._files.length - 1].localHeader = localHeader;
    }

    finalize() {
        const parts = [];
        // Local file records
        for (const f of this._files) {
            parts.push(f.localHeader);
            parts.push(f.data);
        }

        const centralDirOffset = this._offset;
        let centralSize = 0;
        for (const f of this._files) {
            const cd = makeCentralDirectoryHeader(f);
            parts.push(cd);
            centralSize += cd.length;
        }

        const end = makeEndOfCentralDirectory({
            entries: this._files.length,
            centralSize,
            centralDirOffset
        });
        parts.push(end);

        return new Blob(parts, { type: 'application/zip' });
    }
}

function makeLocalFileHeader({ filename, crc, size }) {
    const header = new Uint8Array(30 + filename.length);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true); // version needed
    dv.setUint16(6, 0, true); // flags
    dv.setUint16(8, 0, true); // compression = store
    dv.setUint16(10, 0, true); // mod time
    dv.setUint16(12, 0, true); // mod date
    dv.setUint32(14, crc >>> 0, true);
    dv.setUint32(18, size, true);
    dv.setUint32(22, size, true);
    dv.setUint16(26, filename.length, true);
    dv.setUint16(28, 0, true); // extra len
    header.set(filename, 30);
    return header;
}

function makeCentralDirectoryHeader(file) {
    const { filename, crc, size, localHeaderOffset } = file;
    const header = new Uint8Array(46 + filename.length);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true); // version made by
    dv.setUint16(6, 20, true); // version needed
    dv.setUint16(8, 0, true); // flags
    dv.setUint16(10, 0, true); // compression
    dv.setUint16(12, 0, true); // mod time
    dv.setUint16(14, 0, true); // mod date
    dv.setUint32(16, crc >>> 0, true);
    dv.setUint32(20, size, true);
    dv.setUint32(24, size, true);
    dv.setUint16(28, filename.length, true);
    dv.setUint16(30, 0, true); // extra
    dv.setUint16(32, 0, true); // comment
    dv.setUint16(34, 0, true); // disk start
    dv.setUint16(36, 0, true); // internal attrs
    dv.setUint32(38, 0, true); // external attrs
    dv.setUint32(42, localHeaderOffset, true);
    header.set(filename, 46);
    return header;
}

function makeEndOfCentralDirectory({ entries, centralSize, centralDirOffset }) {
    const header = new Uint8Array(22);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, 0x06054b50, true);
    dv.setUint16(4, 0, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, entries, true);
    dv.setUint16(10, entries, true);
    dv.setUint32(12, centralSize, true);
    dv.setUint32(16, centralDirOffset, true);
    dv.setUint16(20, 0, true);
    return header;
}

function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
        crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c >>> 0;
    }
    return table;
})();


