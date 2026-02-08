import { sanitizeSvgForLogo } from '../utils/svgSanitize.js';

/**
 * Sanitize a single SVG string and parse it with the provided SVGParser.
 */
export function sanitizeAndParse(svgParser, svgString) {
    const sanitized = sanitizeSvgForLogo(svgString);
    const svgData = svgParser.parse(sanitized);
    return { sanitized, svgData };
}

/**
 * Sanitize and parse a list of SVG strings (used for sequencing).
 */
export function sanitizeAndParseMany(svgParser, svgStrings) {
    const list = Array.isArray(svgStrings) ? svgStrings : [];
    const sanitizedStrings = list.map((s) => sanitizeSvgForLogo(s));
    const svgDatas = sanitizedStrings.map((s) => svgParser.parse(s));
    return { sanitizedStrings, svgDatas };
}

/**
 * True if the vector parser produced usable path data.
 */
export function hasVectorPaths(svgData) {
    return !!(svgData && Array.isArray(svgData.paths) && svgData.paths.length > 0);
}


