import sharp from 'sharp';

export interface EngagementControls {
    like: { x: number; y: number };
    comment: { x: number; y: number };
    save: { x: number; y: number };
    confidence: number;
    /** The heart is TikTok red — this video is already liked. */
    liked: boolean;
    /** The bookmark is TikTok yellow — this video is already saved. */
    saved: boolean;
}

export interface DetectOptions {
    /**
     * Expected heart→bookmark distance in points (from the device's coordinate
     * profile: save.y - like.y). The rail can slide up/down (music credits,
     * long captions), but the spacing between its icons stays the same.
     */
    expectedGapPt?: number;
}

interface PixelImage {
    data: Buffer;
    width: number;
    height: number;
    channels: number;
}

// Silhouettes of TikTok's right-rail icons (white = icon), traced from real
// iPhone screenshots. The viewBox is a 34×34 pt box drawn at 2× (68×68), so
// rendering it at 34 × scale px reproduces the on-screen size on any device.
const VIEWBOX = 68;
const TEMPLATE_PT = 34;
const HEART_SVG = '<path fill="white" d="M35 55C30 50 6 38 6 22C6 12 18 6 35 18C52 6 64 12 64 22C64 38 40 50 35 55Z"/>';
const COMMENT_SVG = '<ellipse cx="35" cy="34" rx="28" ry="22" fill="white"/>'
    + '<path fill="white" d="M33 54L37 64L52 52Z"/>'
    + '<circle cx="22" cy="34" r="3.5" fill="black"/><circle cx="35.5" cy="34" r="3.5" fill="black"/><circle cx="49.5" cy="34" r="3.5" fill="black"/>';
const BOOKMARK_SVG = '<path fill="white" d="M15 16Q15 12 19 12H52Q56 12 56 16V58L35.5 48L15 58Z"/>';

/** All three icons must correlate at least this well (normalized, -1..1). */
export const MIN_RAIL_CONFIDENCE = 0.5;
const DEFAULT_GAP_PT = 132;
const STEP = 2; // px grid for the score maps

async function renderTemplate(inner: string, size: number): Promise<Float64Array> {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}">${inner}</svg>`;
    const { data } = await sharp(Buffer.from(svg)).resize(size, size).flatten({ background: 'black' })
        .greyscale().raw().toBuffer({ resolveWithObject: true });
    const values = Float64Array.from(data);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    for (let index = 0; index < values.length; index++) values[index] = values[index]! - mean;
    return values;
}

// TikTok red (liked heart ≈ 254,44,85) and yellow (saved bookmark ≈ 250,202,40).
function isLikedRed(r: number, g: number, b: number): boolean {
    return r > 200 && g < 100 && b > 40 && b < 150;
}
function isSavedYellow(r: number, g: number, b: number): boolean {
    return r > 220 && g > 170 && b < 100;
}

// TikTok's icons are white, so intensity is "whiteness" = min(R,G,B): a
// saturated background (orange, yellow, skin) stays dark instead of looking
// like an icon. The liked-red and saved-yellow icon states count as white.
function iconIntensity(image: PixelImage): Float64Array {
    const values = new Float64Array(image.width * image.height);
    for (let index = 0; index < values.length; index++) {
        const offset = index * image.channels;
        const r = image.data[offset]!;
        const g = image.data[offset + 1]!;
        const b = image.data[offset + 2]!;
        values[index] = isLikedRed(r, g, b) || isSavedYellow(r, g, b) ? 255 : Math.min(r, g, b);
    }
    return values;
}

/** Share of pixels in a square of ±radius px around (cx, cy) that match `test`. */
function colorShare(
    image: PixelImage,
    cx: number,
    cy: number,
    radius: number,
    test: (r: number, g: number, b: number) => boolean,
): number {
    let hits = 0;
    let total = 0;
    for (let y = cy - radius; y <= cy + radius; y++) {
        if (y < 0 || y >= image.height) continue;
        for (let x = cx - radius; x <= cx + radius; x++) {
            if (x < 0 || x >= image.width) continue;
            const offset = (y * image.width + x) * image.channels;
            total += 1;
            if (test(image.data[offset]!, image.data[offset + 1]!, image.data[offset + 2]!)) hits += 1;
        }
    }
    return total ? hits / total : 0;
}

/** The icon centre is filled with the state colour when liked/saved (white otherwise). */
const STATE_RADIUS_PT = 6;
const STATE_MIN_SHARE = 0.5;

function normalizedCorrelation(
    pixels: Float64Array,
    imageWidth: number,
    template: Float64Array,
    size: number,
    left: number,
    top: number,
): number {
    let patchSum = 0;
    for (let y = 0; y < size; y++) {
        const row = (top + y) * imageWidth + left;
        for (let x = 0; x < size; x++) patchSum += pixels[row + x]!;
    }
    const patchMean = patchSum / template.length;
    let covariance = 0;
    let patchEnergy = 0;
    let templateEnergy = 0;
    for (let y = 0; y < size; y++) {
        const row = (top + y) * imageWidth + left;
        const templateRow = y * size;
        for (let x = 0; x < size; x++) {
            const patchValue = pixels[row + x]! - patchMean;
            const templateValue = template[templateRow + x]!;
            covariance += patchValue * templateValue;
            patchEnergy += patchValue * patchValue;
            templateEnergy += templateValue * templateValue;
        }
    }
    if (patchEnergy === 0 || templateEnergy === 0) return -1;
    return covariance / Math.sqrt(patchEnergy * templateEnergy);
}

interface ScoreMap {
    scores: Float64Array;
    cols: number;
    rows: number;
    x0: number;
    y0: number;
}

function scoreMap(
    pixels: Float64Array,
    width: number,
    template: Float64Array,
    size: number,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
): ScoreMap {
    const half = Math.floor(size / 2);
    const cols = Math.floor((x1 - x0) / STEP) + 1;
    const rows = Math.floor((y1 - y0) / STEP) + 1;
    const scores = new Float64Array(cols * rows);
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            scores[row * cols + col] = normalizedCorrelation(
                pixels, width, template, size, x0 + col * STEP - half, y0 + row * STEP - half,
            );
        }
    }
    return { scores, cols, rows, x0, y0 };
}

/** Best score in a small window around (col,row); -1 if the window is off the map. */
function peak(map: ScoreMap, col: number, row: number, colRadius: number, rowRadius: number): { score: number; col: number; row: number } {
    let best = { score: -1, col, row };
    for (let r = row - rowRadius; r <= row + rowRadius; r++) {
        if (r < 0 || r >= map.rows) continue;
        for (let c = col - colRadius; c <= col + colRadius; c++) {
            if (c < 0 || c >= map.cols) continue;
            const score = map.scores[r * map.cols + c]!;
            if (score > best.score) best = { score, col: c, row: r };
        }
    }
    return best;
}

/**
 * Finds TikTok's like / comment / save buttons as one vertical group:
 * heart, then the comment bubble half-way down, then the bookmark, all in the
 * same column at the expected spacing. Matching the group (instead of each
 * icon alone) rejects look-alikes such as the Follow "+" or bright video
 * content. Returns undefined when no group matches confidently — the caller
 * should then skip the tap rather than guess.
 */
export async function detectEngagementControls(
    screenshot: Buffer,
    scale: number,
    options: DetectOptions = {},
): Promise<EngagementControls | undefined> {
    const { data, info } = await sharp(screenshot).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
    const image: PixelImage = { data, width: info.width, height: info.height, channels: info.channels };
    const pixels = iconIntensity(image);
    const size = Math.round(TEMPLATE_PT * scale);
    const half = Math.floor(size / 2);
    const [heartTemplate, commentTemplate, bookmarkTemplate] = await Promise.all([
        renderTemplate(HEART_SVG, size),
        renderTemplate(COMMENT_SVG, size),
        renderTemplate(BOOKMARK_SVG, size),
    ]);

    // Right-hand rail column, most of the screen height.
    const x0 = Math.max(half, Math.floor(image.width * 0.88));
    const x1 = Math.min(image.width - half - 1, Math.ceil(image.width * 0.97));
    const y0 = Math.max(half, Math.floor(image.height * 0.12));
    const y1 = Math.min(image.height - half - 1, Math.ceil(image.height * 0.88));
    const hearts = scoreMap(pixels, image.width, heartTemplate, size, x0, x1, y0, y1);
    const comments = scoreMap(pixels, image.width, commentTemplate, size, x0, x1, y0, y1);
    const bookmarks = scoreMap(pixels, image.width, bookmarkTemplate, size, x0, x1, y0, y1);

    const gapRows = ((options.expectedGapPt ?? DEFAULT_GAP_PT) * scale) / STEP;
    const minGap = Math.floor(gapRows * 0.9);
    const maxGap = Math.ceil(gapRows * 1.1);
    const columnSlack = Math.ceil((4 * scale) / STEP); // icons share one column, ±4 pt
    const commentSlack = Math.ceil((6 * scale) / STEP); // comment ≈ midway, ±6 pt

    // Every icon must clear MIN_RAIL_CONFIDENCE; among those groups the best
    // average wins. (Ranking by average, not the weakest icon, is what keeps a
    // group shifted one slot down — comment/bookmark/share — from winning.)
    let best: { heart: [number, number]; comment: [number, number]; bookmark: [number, number]; mean: number; confidence: number } | undefined;
    for (let row = 0; row < hearts.rows; row++) {
        for (let col = 0; col < hearts.cols; col++) {
            const heartScore = hearts.scores[row * hearts.cols + col]!;
            if (heartScore < MIN_RAIL_CONFIDENCE || (best && (heartScore + 2) / 3 <= best.mean)) continue;
            for (let gap = minGap; gap <= maxGap; gap++) {
                const bookmark = peak(bookmarks, col, row + gap, columnSlack, 0);
                if (bookmark.score < MIN_RAIL_CONFIDENCE) continue;
                const comment = peak(comments, col, row + Math.round(gap / 2), columnSlack, commentSlack);
                const confidence = Math.min(heartScore, bookmark.score, comment.score);
                const mean = (heartScore + bookmark.score + comment.score) / 3;
                if (confidence >= MIN_RAIL_CONFIDENCE && (!best || mean > best.mean)) {
                    best = {
                        heart: [col, row],
                        comment: [comment.col, comment.row],
                        bookmark: [bookmark.col, bookmark.row],
                        mean,
                        confidence,
                    };
                }
            }
        }
    }
    if (!best) return;
    const toPoint = ([col, row]: [number, number]) => ({
        x: Math.round((x0 + col * STEP) / scale),
        y: Math.round((y0 + row * STEP) / scale),
    });
    const toPixel = ([col, row]: [number, number]) => [x0 + col * STEP, y0 + row * STEP] as const;
    const stateRadius = Math.round(STATE_RADIUS_PT * scale);
    const [heartX, heartY] = toPixel(best.heart);
    const [bookmarkX, bookmarkY] = toPixel(best.bookmark);
    return {
        like: toPoint(best.heart),
        comment: toPoint(best.comment),
        save: toPoint(best.bookmark),
        confidence: best.confidence,
        liked: colorShare(image, heartX, heartY, stateRadius, isLikedRed) >= STATE_MIN_SHARE,
        saved: colorShare(image, bookmarkX, bookmarkY, stateRadius, isSavedYellow) >= STATE_MIN_SHARE,
    };
}
