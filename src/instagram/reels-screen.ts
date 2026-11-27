// Reads the Instagram Reels screen off a screenshot: the Reels tab selected,
// the J'aime heart in the right-hand rail and whether it is filled red
// (already liked), "Sponsorisée" on ads, the video progress bar and the
// account name (which tells one Reel from the next). It used to read WDA's
// accessibility tree, which is slow and can hang WDA.
//
// Measured on the French iOS app, iPhone XR at 2x (2026-11-28):
//   - Rail: white outline icons ~22 pt wide at x ≈ 383 pt. On a Reel the
//     heart is at y ≈ 442 pt and the comment bubble 71 pt below it (counts
//     between them); on an ad the rail sits lower and tighter (47 pt apart).
//   - Progress: a 1.5 pt bar right above the tab bar, light grey (~165) for
//     the part played, dark grey (~47) for the rest.
//   - Caption: the account name right of the avatar (then "Suivre"), the
//     caption line below it, "Sponsorisée" at its right end on ads.
//   - Tab bar: five equal slots, Reels second. On Reels the bar is black and
//     the Reels icon is filled white; the other icons are white outlines.

import sharp from 'sharp';

import { bestMatch, edges, loadTemplate, toGray } from '../agent/icon-match.js';
import { recognizeWords, type OcrWord } from '../tiktok/ocr.js';

export type ReelScreenKind =
    /** A normal Reel with the like/comment/share column. */
    | 'reel'
    /** A sponsored Reel or photo ("Sponsorisée"). */
    | 'ad'
    /** Anything else: suggestion and survey cards, Threads posts, pop-ups, sheets. */
    | 'other';

export interface ReelScreen {
    /** The Reels tab is the selected tab. */
    onReels: boolean;
    kind: ReelScreenKind;
    /** J'aime in the right-hand column, centre in points. Absent on 'other'. */
    like?: { x: number; y: number; liked: boolean };
    /** Share of the video played, 0..1. Absent when the bar isn't on screen. */
    progress?: number;
    /** "Reel de <account>" — tells one Reel from the next. */
    reelId?: string;
}

export interface Point { x: number; y: number }

const TEMPLATE_DIR = new URL('./templates/', import.meta.url);
/** Heart and comment bubble must match at least this well (edge correlation, -1..1). */
export const MIN_RAIL_SCORE = 0.45;
/** Heart → comment bubble: 47 pt on ads, 71 pt on Reels. */
const COMMENT_GAP_PT = { min: 38, max: 82 } as const;
/** Centre of the tab bar's icons, from the bottom of the screen (iPhones with a home indicator). */
const TAB_ICONS_FROM_BOTTOM_PT = 58;
/** Where the account name and the caption line are read: shares of the screen height. */
const CAPTION_BAND = { top: 0.78, height: 0.12 } as const;
/** The account name starts right of the avatar. */
const NAME_LEFT_SHARE = { min: 0.11, max: 0.22 } as const;
const SPONSORED = /^(sponsoris[ée]e?|sponsored)$/i;

/** The Reels tab (second of five slots), in points. */
export function reelsTabPoint(window: { width: number; height: number }): Point {
    return { x: Math.round(window.width * 0.3), y: Math.round(window.height - TAB_ICONS_FROM_BOTTOM_PT) };
}

type Pixels = { data: Buffer; width: number; height: number; channels: number };

const luminance = ({ data, width, channels }: Pixels, x: number, y: number) => {
    const o = (y * width + x) * channels;
    return 0.299 * data[o]! + 0.587 * data[o + 1]! + 0.114 * data[o + 2]!;
};

function shares(pixels: Pixels, cx: number, cy: number, radius: number): { bright: number; dark: number } {
    let bright = 0, dark = 0, total = 0;
    for (let y = cy - radius; y <= cy + radius; y++) {
        for (let x = cx - radius; x <= cx + radius; x++) {
            if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) continue;
            const value = luminance(pixels, x, y);
            total++;
            if (value > 200) bright++;
            if (value < 60) dark++;
        }
    }
    return { bright: bright / Math.max(1, total), dark: dark / Math.max(1, total) };
}

/**
 * The Reels tab is selected: the bar is dark, the Reels icon (filled) is much
 * brighter than the direct-message icon next to it, and the home icon is an
 * outline like the direct-message one. A sheet or a browser over the bar fails it.
 */
export function reelsTabSelected(pixels: Pixels, scale: number): boolean {
    const y = Math.round(pixels.height - TAB_ICONS_FROM_BOTTOM_PT * scale);
    const radius = Math.round(12 * scale);
    const home = shares(pixels, Math.round(pixels.width * 0.1), y, radius);
    const reels = shares(pixels, Math.round(pixels.width * 0.3), y, radius);
    const direct = shares(pixels, Math.round(pixels.width * 0.5), y, radius);
    return direct.dark > 0.6 && reels.bright - direct.bright > 0.25 && Math.abs(home.bright - direct.bright) < 0.15;
}

/**
 * Share of the video played, from the bar above the tab bar: the first rows
 * (bottom 15% of the screen) that are all light grey then dark grey across
 * the width. Undefined when no such row is there.
 */
export function readProgressBar(pixels: Pixels): number | undefined {
    const { data, width, height, channels } = pixels;
    for (let y = Math.round(height * 0.85); y < height; y++) {
        let light = 0, dark = 0, lastLight = -1, mixedUp = false;
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * channels;
            const r = data[o]!, g = data[o + 1]!, b = data[o + 2]!;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            if (min > 110 && max - min < 30) {
                // Light after dark means it isn't the bar (text, video).
                if (dark > 2) mixedUp = true;
                light++;
                lastLight = x;
            } else if (min > 30 && max < 75 && max - min < 18) {
                dark++;
            }
        }
        if (mixedUp || light + dark < width * 0.92) continue;
        if (light && lastLight > light + 4) continue;
        // Nothing played: a photo (its bar never fills) or a video just starting.
        // Either way there's no progress to follow yet.
        if (light === 0) return undefined;
        return Math.min(1, light / width);
    }
    return undefined;
}

const isLikedRed = (r: number, g: number, b: number) => r > 200 && g < 90 && b < 120 && r - g > 130;

function redShare(pixels: Pixels, cx: number, cy: number, radius: number): number {
    const { data, width, height, channels } = pixels;
    let red = 0, total = 0;
    for (let y = cy - radius; y <= cy + radius; y++) {
        for (let x = cx - radius; x <= cx + radius; x++) {
            if (x < 0 || y < 0 || x >= width || y >= height) continue;
            const o = (y * width + x) * channels;
            total++;
            if (isLikedRed(data[o]!, data[o + 1]!, data[o + 2]!)) red++;
        }
    }
    return total ? red / total : 0;
}

/**
 * J'aime in the right-hand rail, in pixels. The comment bubble anchors the
 * rail; J'aime is the heart 38-82 pt above it: a white outline, or a filled
 * red heart once liked (the outline template doesn't match that one).
 * Undefined when the rail isn't confidently on screen (cards, sheets,
 * pop-ups): never tap a guess.
 */
export async function findLikeButton(pixels: Pixels, scale: number): Promise<{ x: number; y: number; liked: boolean; score: number } | undefined> {
    const { width, height } = pixels;
    const image = edges(toGray(pixels.data, width, height, pixels.channels));
    const [heart, comment] = await Promise.all([loadTemplate(TEMPLATE_DIR, 'heart', scale), loadTemplate(TEMPLATE_DIR, 'comment', scale)]);
    const bubble = bestMatch(image, comment, Math.floor(width * 0.88), Math.ceil(width * 0.97), Math.floor(height * 0.45), Math.ceil(height * 0.88), 2, true);
    if (bubble.score < MIN_RAIL_SCORE) return undefined;
    const slack = Math.round(4 * scale);
    const top = Math.round(bubble.y - COMMENT_GAP_PT.max * scale);
    const bottom = Math.round(bubble.y - COMMENT_GAP_PT.min * scale);
    const outline = bestMatch(image, heart, bubble.x - slack, bubble.x + slack, top, bottom, 2, true);
    if (outline.score >= MIN_RAIL_SCORE) {
        return { x: outline.x, y: outline.y, liked: redShare(pixels, outline.x, outline.y, Math.round(6 * scale)) > 0.3, score: Math.min(outline.score, bubble.score) };
    }
    // Liked: a run of mostly red rows in the column, about the heart's height (~22 pt).
    let first = -1, last = -1;
    for (let y = top; y <= bottom; y++) {
        if (redShare(pixels, bubble.x, y, Math.round(3 * scale)) > 0.5) {
            if (first < 0) first = y;
            last = y;
        }
    }
    const runPt = (last - first + 1) / scale;
    if (first < 0 || runPt < 10 || runPt > 30) return undefined;
    return { x: bubble.x, y: Math.round((first + last) / 2), liked: true, score: bubble.score };
}

/**
 * "Sponsorisée" and the account name from the caption band's OCR words
 * (screenshot pixels). The name is the first word right of the avatar, up to
 * "Suivre" (an ad's name can be two words: "Evelyn Foster").
 */
export function captionFromWords(words: readonly OcrWord[], width: number): { sponsored: boolean; account?: string } {
    const sponsored = words.some((word) => SPONSORED.test(word.text.trim().replace(/[^\p{L}]/gu, '')));
    const first = words
        .filter((word) => word.x >= width * NAME_LEFT_SHARE.min && word.x <= width * NAME_LEFT_SHARE.max && /[\p{L}\p{N}]{3,}/u.test(word.text))
        .sort((a, b) => a.y - b.y)[0];
    if (!first) return { sponsored };
    const line = words
        .filter((word) => Math.abs(word.y + word.height / 2 - (first.y + first.height / 2)) < first.height * 0.6 && word.x >= first.x)
        .sort((a, b) => a.x - b.x);
    const name: string[] = [];
    for (const word of line) {
        const text = word.text.trim();
        if (/^suivre$|^follow$/i.test(text) || !/[\p{L}\p{N}]{2,}/u.test(text) || name.length === 3) break;
        name.push(text);
    }
    return { sponsored, ...(name.length ? { account: name.join(' ') } : {}) };
}

/** White text only (as black on white), for OCR over video. */
async function whiteText(pixels: Pixels, top: number, height: number): Promise<Buffer> {
    const { data, width, channels } = pixels;
    const mask = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const o = ((y + top) * width + x) * channels;
            mask[y * width + x] = Math.min(data[o]!, data[o + 1]!, data[o + 2]!) > 200 ? 0 : 255;
        }
    }
    return sharp(mask, { raw: { width, height, channels: 1 } }).withMetadata({ density: 300 }).png().toBuffer();
}

async function readCaption(pixels: Pixels): Promise<{ sponsored: boolean; account?: string }> {
    const top = Math.round(pixels.height * CAPTION_BAND.top);
    const height = Math.round(pixels.height * CAPTION_BAND.height);
    const words = (await recognizeWords(await whiteText(pixels, top, height), 30)).map((word) => ({ ...word, y: word.y + top }));
    return captionFromWords(words, pixels.width);
}

export async function decodePixels(screenshot: Buffer): Promise<Pixels> {
    const { data, info } = await sharp(screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: info.channels };
}

/** Classifies the Reels screen on a screenshot (points in the result). */
export async function readReelScreenshot(screenshot: Buffer, scale: number): Promise<ReelScreen> {
    const pixels = await decodePixels(screenshot);
    const onReels = reelsTabSelected(pixels, scale);
    const [like, caption] = await Promise.all([findLikeButton(pixels, scale), readCaption(pixels)]);
    const progress = onReels ? readProgressBar(pixels) : undefined;
    const kind: ReelScreenKind = !like ? 'other' : caption.sponsored ? 'ad' : 'reel';
    return {
        onReels,
        kind,
        ...(like ? { like: { x: Math.round(like.x / scale), y: Math.round(like.y / scale), liked: like.liked } } : {}),
        ...(progress !== undefined ? { progress } : {}),
        // A sheet or pop-up over the Reel has its own names in that band.
        ...(onReels && caption.account ? { reelId: `Reel de ${caption.account}` } : {}),
    };
}
