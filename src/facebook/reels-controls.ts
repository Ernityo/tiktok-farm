import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

export interface ReelsControls {
    /** J'aime button centre, in points. */
    like: { x: number; y: number };
    /** Comment bubble centre, in points (the rail's anchor). */
    comment: { x: number; y: number };
    /** The thumb sits in a filled Facebook-blue circle: this Reel is already liked. */
    liked: boolean;
    /** Weakest of the matched icon scores (normalized correlation, -1..1). */
    confidence: number;
}

interface Gray {
    data: Float64Array;
    width: number;
    height: number;
}

// Reference images were cropped from an iPhone XR screenshot (scale 2) as
// greyscale images (icons are 72×72 px, i.e. 36×36 pt). They are matched on edge strength,
// not brightness: Facebook draws the white icons with a thin dark outline,
// so their edges stay visible over white video where brightness alone fails.
const TEMPLATE_SCALE = 2;
const TEMPLATE_DIR = new URL('./templates/', import.meta.url);

/** Comment bubble and share arrow must both match at least this well. */
export const MIN_RAIL_SCORE = 0.45;
/** The (not yet liked) thumb must match at least this well. */
export const MIN_LIKE_SCORE = 0.45;

// Measured on the XR (points): comment→share is 72.5 pt. J'aime sits 72 pt
// above the comment bubble, or up to ~90 pt when its count wraps onto two
// lines ("453 03 / 9").
const SHARE_GAP_PT = 72.5;
const LIKE_GAP_MIN_PT = 62;
const LIKE_GAP_MAX_PT = 100;
const STEP = 2;

// Liked thumb: white on a filled blue disc (≈ 56,109,240 / 75,102,232).
function isFacebookBlue(r: number, g: number, b: number): boolean {
    return b > 190 && r < 120 && g > 60 && g < 160 && b - r > 100;
}

function toGray(data: Buffer, width: number, height: number, channels: number): Gray {
    const values = new Float64Array(width * height);
    for (let index = 0; index < values.length; index++) {
        const offset = index * channels;
        values[index] = channels < 3
            ? data[offset]!
            : 0.299 * data[offset]! + 0.587 * data[offset + 1]! + 0.114 * data[offset + 2]!;
    }
    return { data: values, width, height };
}

/** Edge strength: |dx| + |dy| with central differences. */
function edges({ data, width, height }: Gray): Gray {
    const out = new Float64Array(width * height);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            out[i] = Math.abs(data[i + 1]! - data[i - 1]!) + Math.abs(data[i + width]! - data[i - width]!);
        }
    }
    return { data: out, width, height };
}

interface Template { values: Float64Array; width: number; height: number }

type TemplateName = 'like' | 'comment' | 'share' | 'show-original';

const templateCache = new Map<string, Promise<Template>>();

function loadTemplate(name: TemplateName, scale: number): Promise<Template> {
    const key = `${name}@${scale}`;
    let cached = templateCache.get(key);
    if (!cached) {
        cached = (async () => {
            const file = fileURLToPath(new URL(`${name}.png`, TEMPLATE_DIR));
            const meta = await sharp(file).metadata();
            const width = Math.round(meta.width! * scale / TEMPLATE_SCALE);
            const height = Math.round(meta.height! * scale / TEMPLATE_SCALE);
            const { data, info } = await sharp(file).resize(width, height).greyscale().raw()
                .toBuffer({ resolveWithObject: true });
            const edge = edges(toGray(data, info.width, info.height, info.channels));
            // Ignore the 1 px border, where edges() leaves zeros.
            const values = edge.data;
            const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
            for (let index = 0; index < values.length; index++) values[index] = values[index]! - mean;
            return { values, width: info.width, height: info.height };
        })();
        templateCache.set(key, cached);
    }
    return cached;
}

function correlation(image: Gray, template: Template, cx: number, cy: number): number {
    const { width, height, values } = template;
    const left = cx - Math.floor(width / 2);
    const top = cy - Math.floor(height / 2);
    if (left < 0 || top < 0 || left + width > image.width || top + height > image.height) return -1;
    let sum = 0;
    for (let y = 0; y < height; y++) {
        const row = (top + y) * image.width + left;
        for (let x = 0; x < width; x++) sum += image.data[row + x]!;
    }
    const mean = sum / values.length;
    let covariance = 0;
    let patchEnergy = 0;
    let templateEnergy = 0;
    for (let y = 0; y < height; y++) {
        const row = (top + y) * image.width + left;
        for (let x = 0; x < width; x++) {
            const p = image.data[row + x]! - mean;
            const t = values[y * width + x]!;
            covariance += p * t;
            patchEnergy += p * p;
            templateEnergy += t * t;
        }
    }
    if (patchEnergy === 0 || templateEnergy === 0) return -1;
    return covariance / Math.sqrt(patchEnergy * templateEnergy);
}

interface Match { x: number; y: number; score: number }

function bestMatch(image: Gray, template: Template, x0: number, x1: number, y0: number, y1: number): Match {
    let best: Match = { x: x0, y: y0, score: -1 };
    for (let y = y0; y <= y1; y += STEP) {
        for (let x = x0; x <= x1; x += STEP) {
            const score = correlation(image, template, x, y);
            if (score > best.score) best = { x, y, score };
        }
    }
    return best;
}

/** Share of blue pixels in a square of ±radius px around (cx, cy). */
function blueShare(rgb: Buffer, width: number, height: number, channels: number, cx: number, cy: number, radius: number): number {
    let hits = 0;
    let total = 0;
    for (let y = cy - radius; y <= cy + radius; y++) {
        if (y < 0 || y >= height) continue;
        for (let x = cx - radius; x <= cx + radius; x++) {
            if (x < 0 || x >= width) continue;
            const o = (y * width + x) * channels;
            total += 1;
            if (isFacebookBlue(rgb[o]!, rgb[o + 1]!, rgb[o + 2]!)) hits += 1;
        }
    }
    return total ? hits / total : 0;
}

/**
 * Finds the J'aime button on a Facebook Reel. The rail (comment bubble with
 * the share arrow below it) is located first; J'aime is then searched just
 * above it, either as a blue disc (already liked) or as the thumb outline.
 * Returns undefined when the rail isn't confidently on screen — suggestion
 * cards, pop-ups, or anything that isn't a normal Reel — so the caller skips
 * the like instead of guessing.
 */
export async function detectReelsControls(screenshot: Buffer, scale: number): Promise<ReelsControls | undefined> {
    const { data: rgb, info } = await sharp(screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const image = edges(toGray(rgb, width, height, channels));
    const [likeT, commentT, shareT] = await Promise.all([
        loadTemplate('like', scale), loadTemplate('comment', scale), loadTemplate('share', scale),
    ]);

    // Rail column: the right ~12% of the screen; comment bubble in the middle band.
    const x0 = Math.floor(width * 0.86);
    const x1 = Math.ceil(width * 0.98);
    const comment = bestMatch(image, commentT, x0, x1, Math.floor(height * 0.4), Math.ceil(height * 0.8));
    if (comment.score < MIN_RAIL_SCORE) return;
    const shareY = Math.round(comment.y + SHARE_GAP_PT * scale);
    const slack = Math.round(6 * scale);
    const share = bestMatch(image, shareT, comment.x - slack, comment.x + slack, shareY - slack, shareY + slack);
    if (share.score < MIN_RAIL_SCORE) return;

    const likeTop = Math.round(comment.y - LIKE_GAP_MAX_PT * scale);
    const likeBottom = Math.round(comment.y - LIKE_GAP_MIN_PT * scale);
    const toPoint = (x: number, y: number) => ({ x: Math.round(x / scale), y: Math.round(y / scale) });
    const railScore = Math.min(comment.score, share.score);

    // Already liked: a filled blue disc (~32 pt) centred in the column.
    const discRadius = Math.round(8 * scale);
    let disc: { y: number; share: number } | undefined;
    for (let y = likeTop; y <= likeBottom; y += STEP) {
        const value = blueShare(rgb, width, height, channels, comment.x, y, discRadius);
        if (value >= 0.4 && (!disc || value > disc.share)) disc = { y, share: value };
    }
    if (disc) {
        // The white thumb fills the disc's centre, so the bluest window sits
        // off-centre. Use the middle of the blue rows in the column instead.
        let top = disc.y;
        let bottom = disc.y;
        const scanRadius = Math.round(20 * scale);
        for (let y = disc.y - scanRadius; y <= disc.y + scanRadius; y++) {
            if (blueShare(rgb, width, height, channels, comment.x, y, 0) === 1
                || blueShare(rgb, width, height, channels, comment.x - discRadius, y, 0) === 1) {
                top = Math.min(top, y);
                bottom = Math.max(bottom, y);
            }
        }
        const centreY = Math.round((top + bottom) / 2);
        return { like: toPoint(comment.x, centreY), comment: toPoint(comment.x, comment.y), liked: true, confidence: railScore };
    }

    const like = bestMatch(image, likeT, comment.x - slack, comment.x + slack, likeTop, likeBottom);
    if (like.score < MIN_LIKE_SCORE) return;
    return {
        like: toPoint(like.x, like.y),
        comment: toPoint(comment.x, comment.y),
        liked: false,
        confidence: Math.min(railScore, like.score),
    };
}

/** "Afficher l'original" must match at least this well. */
export const MIN_SHOW_ORIGINAL_SCORE = 0.5;

// "Afficher l'original" is left-aligned with the caption: its centre sits
// ~66 pt from the left edge on the XR (text starts at the 12.5 pt margin).
const SHOW_ORIGINAL_CENTRE_X_PT = 66.5;

/**
 * True when the Reel's caption carries "Afficher l'original" (Show
 * original): Facebook machine-translated it into French, so the Reel is
 * foreign-language content. Edge-matched like the rail icons, so the grey
 * label still registers over light video.
 */
export async function detectTranslatedCaption(screenshot: Buffer, scale: number): Promise<{ translated: boolean; score: number }> {
    const { data, info } = await sharp(screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const image = edges(toGray(data, width, height, channels));
    const template = await loadTemplate('show-original', scale);
    const cx = Math.round(SHOW_ORIGINAL_CENTRE_X_PT * scale);
    const slack = Math.round(6 * scale);
    // Caption block: below the middle of the video, above the tab bar.
    const match = bestMatch(image, template, cx - slack, cx + slack, Math.floor(height * 0.5), Math.ceil(height * 0.92));
    return { translated: match.score >= MIN_SHOW_ORIGINAL_SCORE, score: match.score };
}
