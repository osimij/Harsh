/**
 * SVG Parser Module
 * Extracts paths and shapes from SVG files and converts them to a normalized format
 */

export class SVGParser {
    constructor() {
        this.svgElement = null;
        this.viewBox = { x: 0, y: 0, width: 100, height: 100 };
        this.colors = [];

        // Reusable SVG elements for parsing transform attributes (perf)
        const SVG_NS = 'http://www.w3.org/2000/svg';
        this._transformSvg = document.createElementNS(SVG_NS, 'svg');
        this._transformG = document.createElementNS(SVG_NS, 'g');
        this._transformSvg.appendChild(this._transformG);
    }

    /**
     * Parse an SVG string and extract drawable elements
     * @param {string} svgString - Raw SVG markup
     * @returns {Object} Parsed SVG data with paths and colors
     */
    parse(svgString) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgString, 'image/svg+xml');
        
        // Check for parsing errors
        const parseError = doc.querySelector('parsererror');
        if (parseError) {
            throw new Error('Invalid SVG file');
        }

        this.svgElement = doc.querySelector('svg');
        if (!this.svgElement) {
            throw new Error('No SVG element found');
        }

        // Extract viewBox
        this.extractViewBox();
        
        // Extract all drawable paths
        const paths = this.extractPaths(this.svgElement);
        
        // Extract colors
        this.colors = [...new Set(paths.map(p => p.color).filter(c => c))];

        return {
            paths,
            viewBox: this.viewBox,
            colors: this.colors,
            width: this.viewBox.width,
            height: this.viewBox.height
        };
    }

    /**
     * Extract viewBox from SVG element
     */
    extractViewBox() {
        const viewBoxAttr = this.svgElement.getAttribute('viewBox');
        if (viewBoxAttr) {
            const parts = viewBoxAttr.split(/[\s,]+/).map(parseFloat);
            if (parts.length === 4) {
                this.viewBox = {
                    x: parts[0],
                    y: parts[1],
                    width: parts[2],
                    height: parts[3]
                };
                return;
            }
        }

        // Fallback to width/height attributes
        const width = parseFloat(this.svgElement.getAttribute('width')) || 100;
        const height = parseFloat(this.svgElement.getAttribute('height')) || 100;
        this.viewBox = { x: 0, y: 0, width, height };
    }

    /**
     * Recursively extract all paths from SVG element
     * @param {Element} element - SVG element to process
     * @param {DOMMatrix} parentTransform - Accumulated transform matrix
     * @returns {Array} Array of path objects
     */
    extractPaths(element, parentTransform = null) {
        const paths = [];
        const transform = this.getTransformMatrix(element, parentTransform);

        for (const child of element.children) {
            const tagName = child.tagName.toLowerCase();
            if (!this.shouldProcessElement(child, tagName)) continue;
            // Leaf nodes can carry their own transform attributes (common in Figma exports).
            const childTransform = this.getTransformMatrix(child, transform);
            
            switch (tagName) {
                case 'path':
                    paths.push(this.parsePath(child, childTransform));
                    break;
                case 'rect':
                    paths.push(this.parseRect(child, childTransform));
                    break;
                case 'circle':
                    paths.push(this.parseCircle(child, childTransform));
                    break;
                case 'ellipse':
                    paths.push(this.parseEllipse(child, childTransform));
                    break;
                case 'polygon':
                    paths.push(this.parsePolygon(child, childTransform));
                    break;
                case 'polyline':
                    paths.push(this.parsePolyline(child, childTransform));
                    break;
                case 'line':
                    paths.push(this.parseLine(child, childTransform));
                    break;
                case 'use':
                    paths.push(...this.parseUse(child, childTransform));
                    break;
                case 'g':
                case 'svg':
                    paths.push(...this.extractPaths(child, transform));
                    break;
            }
        }

        return paths.filter(p => p !== null);
    }

    /**
     * Get combined transform matrix for an element
     */
    getTransformMatrix(element, parentTransform) {
        const transformAttr = element.getAttribute('transform');
        if (!transformAttr && !parentTransform) return null;

        // Parse the transform attribute using a reusable <g> element (no DOM attach needed)
        let matrix = null;
        if (transformAttr) {
            this._transformG.setAttribute('transform', transformAttr);
            const consolidated = this._transformG.transform.baseVal.consolidate();
            matrix = consolidated ? consolidated.matrix : this._transformSvg.createSVGMatrix();
        } else {
            // No local transform: use identity so parentTransform can be returned as-is below
            this._transformG.removeAttribute('transform');
            matrix = this._transformSvg.createSVGMatrix();
        }

        if (parentTransform) {
            // Multiply parent * local
            matrix = parentTransform.multiply(matrix);
        }

        return matrix;
    }

    isIgnoredTag(tagName) {
        return (
            tagName === 'defs' ||
            tagName === 'clippath' ||
            tagName === 'mask' ||
            tagName === 'symbol' ||
            tagName === 'pattern' ||
            tagName === 'marker' ||
            tagName === 'lineargradient' ||
            tagName === 'radialgradient' ||
            tagName === 'filter' ||
            tagName === 'metadata' ||
            tagName === 'title' ||
            tagName === 'desc' ||
            tagName === 'style' ||
            tagName === 'script'
        );
    }

    isHiddenByAttributes(element) {
        let node = element;
        while (node && node.nodeType === 1) {
            const display = (node.getAttribute('display') || this.getStyleProperty(node, 'display') || '').trim().toLowerCase();
            if (display === 'none') return true;

            const visibility = (node.getAttribute('visibility') || this.getStyleProperty(node, 'visibility') || '').trim().toLowerCase();
            if (visibility === 'hidden' || visibility === 'collapse') return true;

            const opacityRaw = node.getAttribute('opacity') || this.getStyleProperty(node, 'opacity');
            const opacity = parseFloat(opacityRaw);
            if (Number.isFinite(opacity) && opacity <= 0) return true;

            node = node.parentElement;
        }
        return false;
    }

    shouldProcessElement(element, tagName = null) {
        const tag = tagName || element.tagName.toLowerCase();
        if (this.isIgnoredTag(tag)) return false;
        if (this.isHiddenByAttributes(element)) return false;
        return true;
    }

    /**
     * Apply transform matrix to a point
     */
    transformPoint(x, y, matrix) {
        if (!matrix) return { x, y };
        return {
            x: matrix.a * x + matrix.c * y + matrix.e,
            y: matrix.b * x + matrix.d * y + matrix.f
        };
    }

    /**
     * Extract color from element
     */
    getColor(element) {
        const fill = element.getAttribute('fill') || 
                     this.getStyleProperty(element, 'fill');
        
        if (fill && fill !== 'none' && fill !== 'transparent') {
            return this.normalizeColor(fill);
        }

        const stroke = element.getAttribute('stroke') ||
                       this.getStyleProperty(element, 'stroke');
        
        if (stroke && stroke !== 'none' && stroke !== 'transparent') {
            return this.normalizeColor(stroke);
        }

        // Default color
        return '#d4d4d8';
    }

    /**
     * Get style property from inline styles
     */
    getStyleProperty(element, property) {
        const style = element.getAttribute('style');
        if (!style) return null;
        
        const match = style.match(new RegExp(`${property}\\s*:\\s*([^;]+)`));
        return match ? match[1].trim() : null;
    }

    /**
     * Normalize color to hex format
     */
    normalizeColor(color) {
        if (!color) return '#d4d4d8';
        
        // Handle url references (gradients)
        if (color.startsWith('url(')) {
            return '#d4d4d8'; // Default for gradients
        }

        // Already hex
        if (color.startsWith('#')) {
            return color.length === 4 
                ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
                : color;
        }

        // RGB/RGBA
        const rgbMatch = color.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (rgbMatch) {
            const r = parseInt(rgbMatch[1]).toString(16).padStart(2, '0');
            const g = parseInt(rgbMatch[2]).toString(16).padStart(2, '0');
            const b = parseInt(rgbMatch[3]).toString(16).padStart(2, '0');
            return `#${r}${g}${b}`;
        }

        // Named colors
        const namedColors = {
            white: '#ffffff', black: '#000000', red: '#ff0000',
            green: '#00ff00', blue: '#0000ff', yellow: '#ffff00',
            cyan: '#00ffff', magenta: '#ff00ff', gray: '#808080',
            grey: '#808080', orange: '#ffa500', purple: '#800080',
            pink: '#ffc0cb', brown: '#a52a2a', navy: '#000080'
        };

        return namedColors[color.toLowerCase()] || '#d4d4d8';
    }

    /**
     * Parse a path element
     */
    parsePath(element, transform) {
        const d = element.getAttribute('d');
        if (!d) return null;

        return {
            type: 'path',
            d: d,
            color: this.getColor(element),
            filled: this.isFilled(element),
            transform: transform
        };
    }

    /**
     * Check if element is filled
     */
    isFilled(element) {
        const fill = element.getAttribute('fill') || 
                     this.getStyleProperty(element, 'fill');
        return fill !== 'none' && fill !== 'transparent';
    }

    /**
     * Parse rect to path
     */
    parseRect(element, transform) {
        const x = parseFloat(element.getAttribute('x')) || 0;
        const y = parseFloat(element.getAttribute('y')) || 0;
        const width = parseFloat(element.getAttribute('width')) || 0;
        const height = parseFloat(element.getAttribute('height')) || 0;
        const rx = parseFloat(element.getAttribute('rx')) || 0;
        const ry = parseFloat(element.getAttribute('ry')) || rx;

        if (width <= 0 || height <= 0) return null;

        let d;
        if (rx > 0 || ry > 0) {
            // Rounded rectangle
            const r = Math.min(rx, width / 2, height / 2);
            d = `M ${x + r} ${y}
                 H ${x + width - r}
                 Q ${x + width} ${y} ${x + width} ${y + r}
                 V ${y + height - r}
                 Q ${x + width} ${y + height} ${x + width - r} ${y + height}
                 H ${x + r}
                 Q ${x} ${y + height} ${x} ${y + height - r}
                 V ${y + r}
                 Q ${x} ${y} ${x + r} ${y}
                 Z`;
        } else {
            d = `M ${x} ${y} H ${x + width} V ${y + height} H ${x} Z`;
        }

        return {
            type: 'path',
            d: d,
            color: this.getColor(element),
            filled: this.isFilled(element),
            transform: transform
        };
    }

    /**
     * Parse circle to path
     */
    parseCircle(element, transform) {
        const cx = parseFloat(element.getAttribute('cx')) || 0;
        const cy = parseFloat(element.getAttribute('cy')) || 0;
        const r = parseFloat(element.getAttribute('r')) || 0;

        if (r <= 0) return null;

        // Approximate circle with bezier curves
        const k = 0.5522847498; // Magic number for bezier circle approximation
        const d = `M ${cx} ${cy - r}
                   C ${cx + r * k} ${cy - r} ${cx + r} ${cy - r * k} ${cx + r} ${cy}
                   C ${cx + r} ${cy + r * k} ${cx + r * k} ${cy + r} ${cx} ${cy + r}
                   C ${cx - r * k} ${cy + r} ${cx - r} ${cy + r * k} ${cx - r} ${cy}
                   C ${cx - r} ${cy - r * k} ${cx - r * k} ${cy - r} ${cx} ${cy - r}
                   Z`;

        return {
            type: 'path',
            d: d,
            color: this.getColor(element),
            filled: this.isFilled(element),
            transform: transform
        };
    }

    /**
     * Parse ellipse to path
     */
    parseEllipse(element, transform) {
        const cx = parseFloat(element.getAttribute('cx')) || 0;
        const cy = parseFloat(element.getAttribute('cy')) || 0;
        const rx = parseFloat(element.getAttribute('rx')) || 0;
        const ry = parseFloat(element.getAttribute('ry')) || 0;

        if (rx <= 0 || ry <= 0) return null;

        const k = 0.5522847498;
        const d = `M ${cx} ${cy - ry}
                   C ${cx + rx * k} ${cy - ry} ${cx + rx} ${cy - ry * k} ${cx + rx} ${cy}
                   C ${cx + rx} ${cy + ry * k} ${cx + rx * k} ${cy + ry} ${cx} ${cy + ry}
                   C ${cx - rx * k} ${cy + ry} ${cx - rx} ${cy + ry * k} ${cx - rx} ${cy}
                   C ${cx - rx} ${cy - ry * k} ${cx - rx * k} ${cy - ry} ${cx} ${cy - ry}
                   Z`;

        return {
            type: 'path',
            d: d,
            color: this.getColor(element),
            filled: this.isFilled(element),
            transform: transform
        };
    }

    /**
     * Parse polygon to path
     */
    parsePolygon(element, transform) {
        const points = element.getAttribute('points');
        if (!points) return null;

        const coords = points.trim().split(/[\s,]+/).map(parseFloat);
        if (coords.length < 6) return null;

        let d = `M ${coords[0]} ${coords[1]}`;
        for (let i = 2; i < coords.length; i += 2) {
            d += ` L ${coords[i]} ${coords[i + 1]}`;
        }
        d += ' Z';

        return {
            type: 'path',
            d: d,
            color: this.getColor(element),
            filled: this.isFilled(element),
            transform: transform
        };
    }

    /**
     * Parse polyline to path
     */
    parsePolyline(element, transform) {
        const points = element.getAttribute('points');
        if (!points) return null;

        const coords = points.trim().split(/[\s,]+/).map(parseFloat);
        if (coords.length < 4) return null;

        let d = `M ${coords[0]} ${coords[1]}`;
        for (let i = 2; i < coords.length; i += 2) {
            d += ` L ${coords[i]} ${coords[i + 1]}`;
        }

        return {
            type: 'path',
            d: d,
            color: this.getColor(element),
            filled: false,
            transform: transform
        };
    }

    /**
     * Parse line to path
     */
    parseLine(element, transform) {
        const x1 = parseFloat(element.getAttribute('x1')) || 0;
        const y1 = parseFloat(element.getAttribute('y1')) || 0;
        const x2 = parseFloat(element.getAttribute('x2')) || 0;
        const y2 = parseFloat(element.getAttribute('y2')) || 0;

        return {
            type: 'path',
            d: `M ${x1} ${y1} L ${x2} ${y2}`,
            color: this.getColor(element),
            filled: false,
            transform: transform
        };
    }

    /**
     * Parse <use> by resolving its referenced element.
     * Supports common Figma exports where geometry is defined under <defs>.
     */
    parseUse(element, transform) {
        const href = (
            element.getAttribute('href') ||
            element.getAttribute('xlink:href') ||
            ''
        ).trim();
        if (!href || !href.startsWith('#') || !this.svgElement) return [];

        const id = href.slice(1);
        if (!id) return [];

        const doc = this.svgElement.ownerDocument || null;
        const ref = doc ? doc.getElementById(id) : null;
        if (!ref || ref === element) return [];
        const resolved = ref.cloneNode(true);
        this.applyUseOverrides(resolved, element);

        // <use x="..." y="..."> behaves like an extra translation.
        const x = parseFloat(element.getAttribute('x')) || 0;
        const y = parseFloat(element.getAttribute('y')) || 0;
        let useTransform = transform;
        if (x !== 0 || y !== 0) {
            const t = this._transformSvg.createSVGMatrix();
            t.e = x;
            t.f = y;
            useTransform = useTransform ? useTransform.multiply(t) : t;
        }

        const tagName = resolved.tagName.toLowerCase();
        switch (tagName) {
            case 'path':
                return [this.parsePath(resolved, useTransform)];
            case 'rect':
                return [this.parseRect(resolved, useTransform)];
            case 'circle':
                return [this.parseCircle(resolved, useTransform)];
            case 'ellipse':
                return [this.parseEllipse(resolved, useTransform)];
            case 'polygon':
                return [this.parsePolygon(resolved, useTransform)];
            case 'polyline':
                return [this.parsePolyline(resolved, useTransform)];
            case 'line':
                return [this.parseLine(resolved, useTransform)];
            case 'g':
            case 'svg':
            case 'symbol':
                return this.extractPaths(resolved, useTransform);
            default:
                return [];
        }
    }

    /**
     * Apply style/presentation attributes from <use> onto the resolved referenced node.
     */
    applyUseOverrides(target, useElement) {
        if (!target || !useElement) return;
        const overridable = [
            'fill',
            'stroke',
            'style',
            'opacity',
            'display',
            'visibility',
            'fill-rule',
            'stroke-width',
            'stroke-linecap',
            'stroke-linejoin',
            'stroke-miterlimit',
            'stroke-dasharray',
            'stroke-dashoffset'
        ];

        for (const attr of overridable) {
            if (useElement.hasAttribute(attr)) {
                target.setAttribute(attr, useElement.getAttribute(attr));
            }
        }
    }

    /**
     * Parse text element (basic conversion to bounding box)
     */
    parseText(element, transform) {
        // For text, we'll create a simple rectangle as a placeholder
        // Real text-to-path conversion requires font rendering
        const x = parseFloat(element.getAttribute('x')) || 0;
        const y = parseFloat(element.getAttribute('y')) || 0;
        const textContent = element.textContent || '';
        
        if (!textContent.trim()) return null;

        // Estimate text dimensions
        const fontSize = parseFloat(element.getAttribute('font-size')) || 16;
        const width = textContent.length * fontSize * 0.6;
        const height = fontSize;

        const d = `M ${x} ${y - height * 0.8} 
                   H ${x + width} 
                   V ${y + height * 0.2} 
                   H ${x} Z`;

        return {
            type: 'path',
            d: d,
            color: this.getColor(element),
            filled: true,
            transform: transform
        };
    }
}
