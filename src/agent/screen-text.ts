// The text on screen, read with OCR off a screenshot: what phone_look lists
// next to the image (it used to list the accessibility tree, which is slow
// and can hang WDA). Words are grouped into phrases (words on one line, close
// together), each with its centre and size in points.

import sharp from 'sharp';

import { recognizeWords, type OcrWord } from '../tiktok/ocr.js';

export interface ScreenPhrase {
    text: string;
    /** Centre, in points. */
    x: number;
    y: number;
    /** Size, in points. */
    width: number;
    height: number;
}

const overlap = (a: OcrWord, b: OcrWord) => {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? (w * h) / Math.min(a.width * a.height, b.width * b.height) : 0;
};

/**
 * OCR noise off icons and video: no letter or digit at all, or one or two
 * characters read with low confidence ("T", "o,", "| a"). Short words read
 * well ("16", "99") stay.
 */
export function isNoise(word: OcrWord): boolean {
    const text = word.text.trim();
    const alphanumeric = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
    if (!alphanumeric) return true;
    return alphanumeric <= 2 && word.confidence < 85;
}

/** Words from several OCR passes, a word dropped when an earlier pass already read that spot. */
export function mergePasses(passes: readonly (readonly OcrWord[])[]): OcrWord[] {
    const merged: OcrWord[] = [];
    for (const pass of passes) {
        for (const word of pass) {
            if (!merged.some((kept) => overlap(kept, word) > 0.3)) merged.push(word);
        }
    }
    return merged;
}

/**
 * Groups words (pixels) into phrases (points): words share a line when their
 * middles are within half a word height, and a phrase breaks at a gap wider
 * than 1.2 word heights. Top to bottom, left to right.
 */
export function groupPhrases(words: readonly OcrWord[], scale: number): ScreenPhrase[] {
    const sorted = words.filter((word) => word.text.trim()).sort((a, b) => (a.y + a.height / 2) - (b.y + b.height / 2));
    const lines: OcrWord[][] = [];
    for (const word of sorted) {
        const middle = word.y + word.height / 2;
        const line = lines.find((candidate) => {
            const first = candidate[0]!;
            return Math.abs(first.y + first.height / 2 - middle) < Math.max(first.height, word.height) * 0.5;
        });
        if (line) line.push(word);
        else lines.push([word]);
    }
    const phrases: ScreenPhrase[] = [];
    for (const line of lines) {
        line.sort((a, b) => a.x - b.x);
        let group: OcrWord[] = [];
        const flush = () => {
            if (!group.length) return;
            const left = Math.min(...group.map((w) => w.x));
            const top = Math.min(...group.map((w) => w.y));
            const right = Math.max(...group.map((w) => w.x + w.width));
            const bottom = Math.max(...group.map((w) => w.y + w.height));
            phrases.push({
                text: group.map((w) => w.text.trim()).join(' '),
                x: Math.round((left + right) / 2 / scale),
                y: Math.round((top + bottom) / 2 / scale),
                width: Math.round((right - left) / scale),
                height: Math.round((bottom - top) / scale),
            });
            group = [];
        };
        for (const word of line) {
            const last = group.at(-1);
            if (last && word.x - (last.x + last.width) > Math.max(last.height, word.height) * 1.2) flush();
            group.push(word);
        }
        flush();
    }
    // Lines were made top to bottom and each is left to right.
    return phrases;
}

/**
 * The text on a screenshot: one OCR pass on the greyscale image (dark text on
 * light) and one on its negative (light text over video or dark bars).
 */
export async function readScreenText(screenshot: Buffer, scale: number): Promise<ScreenPhrase[]> {
    const grey = await sharp(screenshot).greyscale().withMetadata({ density: 300 }).png().toBuffer();
    const negative = await sharp(screenshot).greyscale().negate({ alpha: false }).withMetadata({ density: 300 }).png().toBuffer();
    const passes = await Promise.all([recognizeWords(grey), recognizeWords(negative)]);
    return groupPhrases(mergePasses(passes.map((pass) => pass.filter((word) => !isNoise(word)))), scale);
}

/** One line per phrase, for the MCP look: "text" @(x,y) WxH. */
export function describePhrases(phrases: readonly ScreenPhrase[]): string[] {
    return phrases.map((phrase) => `${JSON.stringify(phrase.text)} @(${phrase.x},${phrase.y}) ${phrase.width}x${phrase.height}`);
}
