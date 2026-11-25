import sharp from 'sharp';

import { recognizeWords } from './ocr.js';

export interface AdDetection {
    isAd: boolean;
    /** The OCR word that matched, e.g. "Publicité". */
    label?: string;
}

// TikTok marks ads with a small grey pill under the caption: "Publicité"
// (fr), "Sponsored"/"Promoted" (en), "Sponsorisé", "Anzeige" (de),
// "Publicidad" (es), "Pubblicità" (it)... Matched by prefix after stripping
// accents, because OCR sometimes drops them ("Publicite").
const AD_LABEL_PREFIXES = ['publicit', 'sponsor', 'promoted', 'anzeige', 'publicidad', 'pubblicit'];

function normalize(text: string): string {
    return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
}

export function isAdLabel(text: string): boolean {
    const word = normalize(text);
    return AD_LABEL_PREFIXES.some((prefix) => word.startsWith(prefix));
}

// Caption area: left 80% of the width (clear of the button rail), from mid
// screen down to just above the bottom tab bar.
const REGION = { left: 0, top: 0.5, width: 0.8, height: 0.42 };

// The label text is pure white. Keeping only near-white pixels (as black text
// on white) removes the video behind it, which otherwise defeats Tesseract.
// 215 separates the label from most bright video content; 235 is a stricter
// retry for labels drawn over light-grey content (e.g. a silver chain).
const WHITE_THRESHOLDS = [215, 235];

async function whiteTextImage(screenshot: Buffer, threshold: number): Promise<Buffer> {
    const { width = 0, height = 0 } = await sharp(screenshot).metadata();
    const { data, info } = await sharp(screenshot)
        .extract({
            left: Math.round(width * REGION.left),
            top: Math.round(height * REGION.top),
            width: Math.round(width * REGION.width),
            height: Math.round(height * REGION.height),
        })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const mask = Buffer.alloc(info.width * info.height);
    for (let index = 0; index < mask.length; index++) {
        const offset = index * info.channels;
        const whiteness = Math.min(data[offset]!, data[offset + 1]!, data[offset + 2]!);
        mask[index] = whiteness > threshold ? 0 : 255;
    }
    return sharp(mask, { raw: { width: info.width, height: info.height, channels: 1 } })
        .withMetadata({ density: 300 })
        .png()
        .toBuffer();
}

/** Reads the caption area of a TikTok feed screenshot for an ad label. */
export async function detectAd(screenshot: Buffer): Promise<AdDetection> {
    for (const threshold of WHITE_THRESHOLDS) {
        const words = await recognizeWords(await whiteTextImage(screenshot, threshold));
        const match = words.find((word) => isAdLabel(word.text));
        if (match) return { isAd: true, label: match.text };
    }
    return { isAd: false };
}
