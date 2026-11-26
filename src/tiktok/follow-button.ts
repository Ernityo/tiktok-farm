import sharp from 'sharp';

// The Follow "+" on TikTok's right rail: a red disc (TikTok red, like a
// liked heart) with a white +, overlapping the bottom of the creator's
// avatar, centred ~50 pt above the heart in the same column (measured on
// iPhone XR screenshots, normal and shifted-down rails). It's gone once you
// follow the creator, so finding no disc means "already following".

/** Search window around the expected spot, in points, relative to the heart centre. */
const WINDOW = { halfWidth: 20, top: -72, bottom: -30 } as const;
/** The disc is ~22 pt across. */
const DISC_PT = 22;

function isTikTokRed(r: number, g: number, b: number): boolean {
    return r > 200 && g < 100 && b > 40 && b < 150;
}

/**
 * Where the Follow + is (points), given the heart's centre from
 * detectEngagementControls, or undefined when there is no + (already
 * following, or not a normal video).
 */
export async function detectFollowPlus(screenshot: Buffer, scale: number, heart: { x: number; y: number }): Promise<{ x: number; y: number } | undefined> {
    const { data, info } = await sharp(screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const x0 = Math.max(0, Math.round((heart.x - WINDOW.halfWidth) * scale));
    const x1 = Math.min(info.width - 1, Math.round((heart.x + WINDOW.halfWidth) * scale));
    const y0 = Math.max(0, Math.round((heart.y + WINDOW.top) * scale));
    const y1 = Math.min(info.height - 1, Math.round((heart.y + WINDOW.bottom) * scale));
    const diameter = DISC_PT * scale;

    // Rows with a real slice of the disc (not stray red video pixels).
    const rows: Array<{ y: number; count: number; sumX: number; minX: number; maxX: number }> = [];
    for (let y = y0; y <= y1; y++) {
        let count = 0;
        let sumX = 0;
        let minX = Infinity;
        let maxX = -Infinity;
        for (let x = x0; x <= x1; x++) {
            const i = (y * info.width + x) * info.channels;
            if (!isTikTokRed(data[i]!, data[i + 1]!, data[i + 2]!)) continue;
            count += 1;
            sumX += x;
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
        }
        if (count >= diameter * 0.15) rows.push({ y, count, sumX, minX, maxX });
    }
    if (!rows.length) return undefined;

    // The longest run of consecutive rows (small gaps allowed) is the disc.
    let best: typeof rows = [];
    let run: typeof rows = [];
    for (const row of rows) {
        if (run.length && row.y - run[run.length - 1]!.y > Math.ceil(2 * scale)) run = [];
        run.push(row);
        if (run.length > best.length) best = [...run];
    }
    const height = best[best.length - 1]!.y - best[0]!.y + 1;
    const width = Math.max(...best.map((row) => row.maxX)) - Math.min(...best.map((row) => row.minX)) + 1;
    const pixels = best.reduce((sum, row) => sum + row.count, 0);
    const discArea = Math.PI * (diameter / 2) ** 2;
    // Disc-shaped: about as tall as wide, near the expected size, mostly red (the + is white).
    if (height < diameter * 0.65 || height > diameter * 1.4 || width < diameter * 0.65 || width > diameter * 1.4) return undefined;
    if (pixels < discArea * 0.45) return undefined;

    const centreX = best.reduce((sum, row) => sum + row.sumX, 0) / pixels;
    const centreY = best.reduce((sum, row) => sum + row.y * row.count, 0) / pixels;
    // Same column as the heart.
    if (Math.abs(centreX / scale - heart.x) > 6) return undefined;
    return { x: Math.round(centreX / scale), y: Math.round(centreY / scale) };
}
