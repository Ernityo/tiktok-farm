import sharp from 'sharp';

// Facebook draws a thin progress bar along the bottom edge of the video,
// just above the tab bar: a translucent white track with a solid white fill
// growing from the left. Measured on the XR (points): 2 pt high at
// 816–818 pt, from 12 pt to 401.5 pt across. Not every Reel shows it.
const BAR_TOP_PT = 816;
const BAR_HEIGHT_PT = 2;
const BAR_LEFT_PT = 12;
const BAR_RIGHT_PT = 401.5;
/** Video row used as the "no overlay" reference, just above the bar. */
const REFERENCE_GAP_PT = 2;

/** The track darkens nothing and lightens the video by roughly this share. */
const TRACK_ALPHA_MIN = 0.15;
const TRACK_ALPHA_MAX = 0.7;
const FILL_MIN = 238;
/** Video this bright leaves the white overlay invisible: those columns don't count. */
const UNREADABLE_REFERENCE = 225;
/** Share of readable columns that must look like track or fill. */
const MIN_BAR_COVERAGE = 0.7;
/** At least this share of the bar width must be readable at all. */
const MIN_READABLE = 0.4;

type Column = 'fill' | 'track' | 'other' | 'unknown';

/**
 * Reads the Reel's progress bar. Returns 0..1 (share of the video played),
 * or undefined when no bar is on screen.
 */
export async function readReelProgress(screenshot: Buffer, scale: number): Promise<number | undefined> {
    const { data, info } = await sharp(screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const top = Math.round(BAR_TOP_PT * scale);
    const bottom = Math.round((BAR_TOP_PT + BAR_HEIGHT_PT) * scale) - 1;
    const referenceY = top - Math.round(REFERENCE_GAP_PT * scale);
    const left = Math.round(BAR_LEFT_PT * scale);
    const right = Math.min(width - 1, Math.round(BAR_RIGHT_PT * scale));
    if (referenceY < 0 || bottom >= height) return undefined;

    const luma = (x: number, y: number) => {
        const o = (y * width + x) * channels;
        return 0.299 * data[o]! + 0.587 * data[o + 1]! + 0.114 * data[o + 2]!;
    };
    // The bar's anti-aliased top and bottom rows are skipped.
    const rows: number[] = [];
    for (let y = top + 1; y <= bottom - 1; y++) rows.push(y);
    if (!rows.length) rows.push(top);

    const columns: Column[] = [];
    // The rounded left cap is anti-aliased: start a point in.
    for (let x = left + Math.round(scale); x <= right - Math.round(scale); x++) {
        const bar = rows.reduce((sum, y) => sum + luma(x, y), 0) / rows.length;
        const reference = luma(x, referenceY);
        if (bar >= FILL_MIN) {
            columns.push(reference >= UNREADABLE_REFERENCE ? 'unknown' : 'fill');
            continue;
        }
        if (reference >= UNREADABLE_REFERENCE) { columns.push('unknown'); continue; }
        const alpha = (bar - reference) / (255 - reference);
        columns.push(alpha >= TRACK_ALPHA_MIN && alpha <= TRACK_ALPHA_MAX ? 'track' : 'other');
    }

    const readable = columns.filter((column) => column !== 'unknown').length;
    if (readable < columns.length * MIN_READABLE) return undefined;
    const barLike = columns.filter((column) => column === 'fill' || column === 'track').length;
    if (barLike < readable * MIN_BAR_COVERAGE) return undefined;

    // The fill ends at the last fill column such that most of the bar before
    // it is fill too (tolerates a few columns lost to bright video).
    let fillEnd = 0;
    let fillOrUnknown = 0;
    for (let index = 0; index < columns.length; index++) {
        const column = columns[index]!;
        if (column === 'fill' || column === 'unknown') fillOrUnknown += 1;
        if (column === 'fill' && fillOrUnknown >= (index + 1) * 0.8) fillEnd = index + 1;
    }
    return fillEnd / columns.length;
}

export interface ProgressSample { atMs: number; progress: number }

export type WatchState =
    | { kind: 'watching' }
    | { kind: 'completed'; durationMs?: number };

/**
 * Follows one Reel's progress across samples. Reels loop, so the video has
 * played to the end when the bar jumps from near the end back to the start.
 */
export class ReelWatchTracker {
    private samples: ProgressSample[] = [];

    add(sample: ProgressSample): WatchState {
        const previous = this.samples.at(-1);
        this.samples.push(sample);
        if (previous && sample.progress < previous.progress - 0.3) {
            return { kind: 'completed', durationMs: this.estimateDurationMs() };
        }
        return { kind: 'watching' };
    }

    /** Video length from the samples taken before the loop. */
    estimateDurationMs(): number | undefined {
        // Before the wrap: the last sample is the first one of the new loop.
        let end = this.samples.length - 1;
        if (end >= 1 && this.samples[end]!.progress < this.samples[end - 1]!.progress) end -= 1;
        const first = this.samples[0];
        const last = this.samples[end];
        if (!first || !last) return undefined;
        const advanced = last.progress - first.progress;
        if (advanced < 0.1) return undefined;
        return Math.round((last.atMs - first.atMs) / advanced);
    }
}
