/**
 * Point Sampler Module
 * Converts SVG paths to point clouds using adaptive sampling
 */

export class PointSampler {
    constructor() {
        this.canvas = null;
        this.ctx = null;

        // Reuse a single hidden SVG path element for geometry queries (perf)
        this._metricsSvg = null;
        this._metricsPath = null;
        this._currentMetricsD = null;

        // Caches (cleared per-sample call)
        this._localLengthCache = new Map(); // d -> length
        this._effectiveLengthCache = new Map(); // d|matrix -> length
        this._boundsCache = new Map(); // d|matrix -> bounds
    }

    /**
     * Sample points from parsed SVG data
     * @param {Object} svgData - Parsed SVG data from SVGParser
     * @param {number} targetPoints - Target number of points
     * @returns {Array} Array of point objects with x, y, z, color
     */
    sample(svgData, targetPoints = 15000) {
        const points = [];
        const { paths, viewBox } = svgData;

        // Create temp canvas for path operations
        this.createTempCanvas(viewBox.width, viewBox.height);

        // Reset caches for this sampling run
        this._localLengthCache.clear();
        this._effectiveLengthCache.clear();
        this._boundsCache.clear();

        // Calculate total path length for distribution
        let totalLength = 0;
        const pathLengths = []; // { localLength, effectiveLength }

        for (const pathData of paths) {
            const localLength = this.getPathLengthLocal(pathData.d);
            const effectiveLength = this.getPathLengthEffective(pathData, localLength);
            pathLengths.push({ localLength, effectiveLength });
            totalLength += effectiveLength;
        }

        if (totalLength <= 0) return [];

        // Sample points proportionally from each path
        for (let i = 0; i < paths.length; i++) {
            const pathData = paths[i];
            const { localLength, effectiveLength } = pathLengths[i];

            // Points allocated to this path based on its length.
            // If the shape isn't filled (stroke/outline-only), allocate the *full* budget to edge points.
            const edgeWeight = pathData.filled ? 0.6 : 1.0;
            const pathPoints = Math.ceil((effectiveLength / totalLength) * targetPoints * edgeWeight);

            // Sample edge points
            const edgePoints = this.samplePathEdge(pathData, pathPoints, localLength);
            points.push(...edgePoints);

            // Sample fill points if path is filled
            if (pathData.filled) {
                const fillPoints = Math.ceil((effectiveLength / totalLength) * targetPoints * 0.4);
                const interiorPoints = this.samplePathInterior(pathData, fillPoints, viewBox);
                points.push(...interiorPoints);
            }
        }

        // Normalize points to [-1, 1] range centered at origin
        return this.normalizePoints(points, viewBox);
    }

    /**
     * Create temporary canvas for path operations
     */
    createTempCanvas(width, height) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = Math.max(width, 1);
        this.canvas.height = Math.max(height, 1);
        this.ctx = this.canvas.getContext('2d');
    }

    /**
     * Ensure we have a reusable hidden SVG path element for geometry queries.
     * Avoids repeated create/append/remove cycles (perf).
     */
    ensureMetricsPath() {
        if (this._metricsPath) return;

        const SVG_NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('width', '0');
        svg.setAttribute('height', '0');
        svg.style.cssText =
            'position:fixed;left:-10000px;top:-10000px;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;';

        const path = document.createElementNS(SVG_NS, 'path');
        svg.appendChild(path);

        // Attach once if possible. Some SVG geometry APIs are more reliable when connected.
        if (document.body) {
            document.body.appendChild(svg);
        }

        this._metricsSvg = svg;
        this._metricsPath = path;
    }

    /**
     * Update the reusable SVG path element's `d` attribute (no-op if unchanged).
     */
    setMetricsPathD(d) {
        this.ensureMetricsPath();
        if (this._currentMetricsD === d) return;
        this._metricsPath.setAttribute('d', d);
        this._currentMetricsD = d;
    }

    /**
     * Get total length of a path in its local coordinates (cached).
     */
    getPathLengthLocal(d) {
        const cached = this._localLengthCache.get(d);
        if (cached !== undefined) return cached;

        this.setMetricsPathD(d);
        const length = this._metricsPath.getTotalLength();
        this._localLengthCache.set(d, length);
        return length;
    }

    /**
     * Approximate path length after applying an affine transform (cached).
     * Used only for distributing points between paths; sampling still uses local arc-length.
     */
    getPathLengthEffective(pathData, localLength) {
        const matrix = pathData.transform;
        if (!matrix) return localLength;

        const key = `${pathData.d}|${this.matrixKey(matrix)}`;
        const cached = this._effectiveLengthCache.get(key);
        if (cached !== undefined) return cached;

        // Approximate transformed length by sampling a few points along the path
        this.setMetricsPathD(pathData.d);
        const segments = Math.min(80, Math.max(16, Math.ceil(localLength / 20)));
        let sum = 0;

        let prev = this._metricsPath.getPointAtLength(0);
        let prevT = this.applyTransform({ x: prev.x, y: prev.y }, matrix);

        for (let i = 1; i <= segments; i++) {
            const t = (localLength * i) / segments;
            const p = this._metricsPath.getPointAtLength(t);
            const pT = this.applyTransform({ x: p.x, y: p.y }, matrix);
            const dx = pT.x - prevT.x;
            const dy = pT.y - prevT.y;
            sum += Math.hypot(dx, dy);
            prevT = pT;
        }

        this._effectiveLengthCache.set(key, sum);
        return sum;
    }

    matrixKey(matrix) {
        return `${matrix.a},${matrix.b},${matrix.c},${matrix.d},${matrix.e},${matrix.f}`;
    }

    /**
     * Sample points along path edge
     */
    samplePathEdge(pathData, numPoints, localLength) {
        const points = [];
        const totalLength = localLength;

        if (totalLength === 0 || numPoints === 0) return points;

        this.setMetricsPathD(pathData.d);
        const step = totalLength / numPoints;

        for (let i = 0; i < numPoints; i++) {
            const length = i * step + Math.random() * step * 0.5;
            const p = this._metricsPath.getPointAtLength(length);
            const point = { x: p.x, y: p.y };

            // Apply transform if exists
            if (pathData.transform) {
                const transformed = this.applyTransform(point, pathData.transform);
                point.x = transformed.x;
                point.y = transformed.y;
            }

            points.push({
                x: point.x,
                y: point.y,
                z: (Math.random() - 0.5) * 2, // Random depth
                color: pathData.color,
                edge: true
            });
        }

        return points;
    }

    /**
     * Apply transform matrix to point
     */
    applyTransform(point, matrix) {
        return {
            x: matrix.a * point.x + matrix.c * point.y + matrix.e,
            y: matrix.b * point.x + matrix.d * point.y + matrix.f
        };
    }

    /**
     * Sample points inside filled path using rejection sampling
     */
    samplePathInterior(pathData, numPoints, viewBox) {
        const points = [];
        const path = new Path2D(pathData.d);

        // Get path bounding box
        const bounds = this.getPathBounds(pathData, viewBox);

        let attempts = 0;
        const maxAttempts = numPoints * 20;

        const hasTransform = !!pathData.transform;
        if (hasTransform) {
            this.ctx.save();
            const m = pathData.transform;
            this.ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
        }

        while (points.length < numPoints && attempts < maxAttempts) {
            attempts++;

            // Random point in bounding box
            const x = bounds.minX + Math.random() * (bounds.maxX - bounds.minX);
            const y = bounds.minY + Math.random() * (bounds.maxY - bounds.minY);

            // Check if point is inside path
            if (this.ctx.isPointInPath(path, x, y)) {
                points.push({
                    // When a transform is present, we sample/test in transformed space directly.
                    x: x,
                    y: y,
                    z: (Math.random() - 0.5) * 2,
                    color: pathData.color,
                    edge: false
                });
            }
        }

        if (hasTransform) {
            this.ctx.restore();
            this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        }

        return points;
    }

    /**
     * Get bounding box of path
     */
    getPathBounds(pathData, viewBox) {
        const key = `${pathData.d}|${pathData.transform ? this.matrixKey(pathData.transform) : 'none'}`;
        const cached = this._boundsCache.get(key);
        if (cached) return cached;

        this.setMetricsPathD(pathData.d);
        const bbox = this._metricsPath.getBBox();

        let bounds = {
            minX: bbox.x,
            minY: bbox.y,
            maxX: bbox.x + bbox.width,
            maxY: bbox.y + bbox.height
        };

        // Expand bounds into transformed space if needed
        if (pathData.transform) {
            bounds = this.transformBounds(bounds, pathData.transform);
        }

        this._boundsCache.set(key, bounds);
        return bounds;
    }

    /**
     * Transform an axis-aligned bounds box by an affine matrix, returning a new axis-aligned bounds.
     */
    transformBounds(bounds, matrix) {
        const corners = [
            { x: bounds.minX, y: bounds.minY },
            { x: bounds.maxX, y: bounds.minY },
            { x: bounds.maxX, y: bounds.maxY },
            { x: bounds.minX, y: bounds.maxY }
        ].map(p => this.applyTransform(p, matrix));

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of corners) {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
        }
        return { minX, minY, maxX, maxY };
    }

    /**
     * Normalize points to [-1, 1] range
     */
    normalizePoints(points, viewBox) {
        if (points.length === 0) return points;

        // Find actual bounds
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;

        for (const p of points) {
            minX = Math.min(minX, p.x);
            maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y);
            maxY = Math.max(maxY, p.y);
        }

        const width = maxX - minX || 1;
        const height = maxY - minY || 1;
        const scale = 2 / Math.max(width, height);
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;

        return points.map(p => ({
            x: (p.x - centerX) * scale,
            y: -(p.y - centerY) * scale, // Flip Y for WebGL
            z: p.z,
            color: p.color,
            edge: p.edge
        }));
    }

    /**
     * Poisson disk sampling for more even distribution
     */
    poissonDiskSample(points, minDistance = 0.02) {
        if (points.length < 2) return points;

        const result = [];
        const grid = new Map();
        const cellSize = minDistance / Math.sqrt(2);

        const getGridKey = (x, y) => {
            const gx = Math.floor(x / cellSize);
            const gy = Math.floor(y / cellSize);
            return `${gx},${gy}`;
        };

        // Shuffle points
        const shuffled = [...points].sort(() => Math.random() - 0.5);

        for (const point of shuffled) {
            const key = getGridKey(point.x, point.y);

            // Check nearby cells
            let tooClose = false;
            for (let dx = -2; dx <= 2; dx++) {
                for (let dy = -2; dy <= 2; dy++) {
                    const neighborKey = getGridKey(
                        point.x + dx * cellSize,
                        point.y + dy * cellSize
                    );
                    const neighbor = grid.get(neighborKey);
                    if (neighbor) {
                        const dist = Math.sqrt(
                            Math.pow(point.x - neighbor.x, 2) +
                            Math.pow(point.y - neighbor.y, 2)
                        );
                        if (dist < minDistance) {
                            tooClose = true;
                            break;
                        }
                    }
                }
                if (tooClose) break;
            }

            if (!tooClose) {
                grid.set(key, point);
                result.push(point);
            }
        }

        return result;
    }
}
