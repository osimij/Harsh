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
    const sanitizedStrings = [];
    const svgDatas = [];
    const failedIndexes = [];

    for (let i = 0; i < list.length; i++) {
        const sanitized = sanitizeSvgForLogo(list[i]);
        sanitizedStrings.push(sanitized);
        try {
            svgDatas.push(svgParser.parse(sanitized));
        } catch (_err) {
            svgDatas.push(null);
            failedIndexes.push(i);
        }
    }

    return { sanitizedStrings, svgDatas, failedIndexes };
}

/**
 * True if the vector parser produced usable path data.
 */
export function hasVectorPaths(svgData) {
    return !!(svgData && Array.isArray(svgData.paths) && svgData.paths.length > 0);
}

