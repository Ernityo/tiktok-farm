import sharp from 'sharp';

// TikTok draws a thin progress bar on longer videos, just above the bottom
// tab bar (inside the "Liste de lecture" / "Recherche" strip when there is
// one): a faint translucent-white track across the width with a brighter
// translucent-white fill and a round handle growing from the left. Measured on
// the XR (points): 2 pt high, its inner rows 2–2.5 pt above the tab bar's
// top divider, from 13 pt to 14 pt short of the right edge. Short videos have
// no bar.
//
// The position is taken from the divider (a 1-pixel grey line with the black
// tab bar under it) so it doesn't depend on a fixed screen height.

const BAR_INNER_PT = [2.5, 2] as const;
/** Rows of plain background above and below the bar, for comparison. */
const REFERENCE_ABOVE_PT = 4.5;
const REFERENCE_BELOW_PT = 0.5;
const BAR_LEFT_PT = 13;
const BAR_RIGHT_INSET_PT = 14;

/** The bar lightens the background by this share (alpha of its white). */
const TRACK_ALPHA = [0.03, 0.3] as const;
const FILL_ALPHA_MAX = 0.85;
/** Background this bright leaves the white overlay unreadable. */
const UNREADABLE_REFERENCE = 215;
/** Share of readable columns that must look like track or fill. Bars measured ≥ 0.94, other screens ≤ 0.37. */
const MIN_BAR_COVERAGE = 0.75;
const MIN_READABLE = 0.4;

type Column = 'fill' | 'track' | 'other' | 'unknown';

interface Pixels { data: Buffer; width: number; height: number; channels: number }

function luma({ data, width, channels }: Pixels, x: number, y: number): number {
    const o = (y * width + x) * channels;
    return 0.299 * data[o]! + 0.587 * data[o + 1]! + 0.114 * data[o + 2]!;
}

/** The tab bar's top divider: a flat grey row with near-black right under it. */
export function findTabBarDivider(pixels: Pixels): number | undefined {
    const step = 4;
    for (let y = pixels.height - 2; y >= Math.floor(pixels.height * 0.7); y--) {
        let min = 255;
        let max = 0;
        let sum = 0;
        let below = 0;
        let count = 0;
        for (let x = 0; x < pixels.width; x += step) {
            const value = luma(pixels, x, y);
            min = Math.min(min, value);
            max = Math.max(max, value);
            sum += value;
            below += luma(pixels, x, y + 1);
            count += 1;
        }
        const mean = sum / count;
        if (max - min <= 8 && mean >= 25 && mean <= 90 && below / count < 15) return y;
    }
    return undefined;
}

/**
 * Reads TikTok's progress bar. Returns 0..1 (share of the video played), or
 * undefined when no bar is on screen (short video, ad, LIVE, other screen).
 */
export async function readTikTokProgress(screenshot: Buffer, scale: number): Promise<number | undefined> {
    const { data, info } = await sharp(screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixels: Pixels = { data, width: info.width, height: info.height, channels: info.channels };
    const divider = findTabBarDivider(pixels);
    if (divider === undefined) return undefined;
    const at = (pt: number) => divider - Math.round(pt * scale);
    const rows = [at(BAR_INNER_PT[0]), at(BAR_INNER_PT[1])];
    const above = at(REFERENCE_ABOVE_PT);
    const below = at(REFERENCE_BELOW_PT);
    if (above < 0) return undefined;
    const left = Math.round(BAR_LEFT_PT * scale);
    const right = pixels.width - 1 - Math.round(BAR_RIGHT_INSET_PT * scale);

    const columns: Column[] = [];
    for (let x = left; x <= right; x++) {
        const reference = (luma(pixels, x, above) + luma(pixels, x, below)) / 2;
        if (reference >= UNREADABLE_REFERENCE) { columns.push('unknown'); continue; }
        const bar = rows.reduce((sum, y) => sum + luma(pixels, x, y), 0) / rows.length;
        const alpha = (bar - reference) / (255 - reference);
        if (alpha >= TRACK_ALPHA[1] && alpha <= FILL_ALPHA_MAX) columns.push('fill');
        else if (alpha >= TRACK_ALPHA[0] && alpha < TRACK_ALPHA[1]) columns.push('track');
        else columns.push('other');
    }

    const readable = columns.filter((column) => column !== 'unknown').length;
    if (readable < columns.length * MIN_READABLE) return undefined;
    const barLike = columns.filter((column) => column === 'fill' || column === 'track').length;
    if (barLike < readable * MIN_BAR_COVERAGE) return undefined;

    // The fill ends at the last fill column such that most of the bar before
    // it is fill too (ignores stray bright columns further right).
    let fillEnd = 0;
    let fillOrUnknown = 0;
    for (let index = 0; index < columns.length; index++) {
        const column = columns[index]!;
        if (column === 'fill' || column === 'unknown') fillOrUnknown += 1;
        if (column === 'fill' && fillOrUnknown >= (index + 1) * 0.8) fillEnd = index + 1;
    }
    return fillEnd / columns.length;
}
