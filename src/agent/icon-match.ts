// Finds small icons (Reels rail buttons, labels) on screenshots by template
// matching on edge strength, not brightness: the apps draw white icons with
// a thin dark outline or shadow, so their edges stay visible over white video
// where brightness alone fails. Shared by Facebook and Instagram.

import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

export interface Gray {
    data: Float64Array;
    width: number;
    height: number;
}

export function toGray(data: Buffer, width: number, height: number, channels: number): Gray {
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
export function edges({ data, width, height }: Gray): Gray {
    const out = new Float64Array(width * height);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            out[i] = Math.abs(data[i + 1]! - data[i - 1]!) + Math.abs(data[i + width]! - data[i - width]!);
        }
    }
    return { data: out, width, height };
}

export interface Template { values: Float64Array; width: number; height: number }

const templateCache = new Map<string, Promise<Template>>();

/**
 * A template image (greyscale PNG cropped at `templateScale`) resized to the
 * screenshot's scale, as zero-mean edge strength.
 */
export function loadTemplate(directory: URL, name: string, scale: number, templateScale = 2): Promise<Template> {
    const file = fileURLToPath(new URL(`${name}.png`, directory));
    const key = `${file}@${scale}`;
    let cached = templateCache.get(key);
    if (!cached) {
        cached = (async () => {
            const meta = await sharp(file).metadata();
            const width = Math.round(meta.width! * scale / templateScale);
            const height = Math.round(meta.height! * scale / templateScale);
            const { data, info } = await sharp(file).resize(width, height).greyscale().raw()
                .toBuffer({ resolveWithObject: true });
            const values = edges(toGray(data, info.width, info.height, info.channels)).data;
            const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
            for (let index = 0; index < values.length; index++) values[index] = values[index]! - mean;
            return { values, width: info.width, height: info.height };
        })();
        templateCache.set(key, cached);
    }
    return cached;
}

/** Normalized correlation (-1..1) of the template centred on (cx, cy). */
export function correlation(image: Gray, template: Template, cx: number, cy: number): number {
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

export interface Match { x: number; y: number; score: number }

/**
 * Best template position with its centre in [x0..x1] × [y0..y1], every `step`
 * px. With `refine`, the best spot is then searched pixel by pixel around it:
 * thin edges lose most of their correlation one pixel off.
 */
export function bestMatch(image: Gray, template: Template, x0: number, x1: number, y0: number, y1: number, step = 2, refine = false): Match {
    let best: Match = { x: x0, y: y0, score: -1 };
    for (let y = y0; y <= y1; y += step) {
        for (let x = x0; x <= x1; x += step) {
            const score = correlation(image, template, x, y);
            if (score > best.score) best = { x, y, score };
        }
    }
    if (refine && step > 1) {
        const coarse = best;
        for (let y = coarse.y - step + 1; y <= coarse.y + step - 1; y++) {
            for (let x = coarse.x - step + 1; x <= coarse.x + step - 1; x++) {
                const score = correlation(image, template, x, y);
                if (score > best.score) best = { x, y, score };
            }
        }
    }
    return best;
}
