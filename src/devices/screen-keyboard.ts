// The on-screen keyboard read off screenshots, for the typing engine in
// typing.ts. It used to be read from WDA's accessibility tree (seconds per
// read on a busy app, and the tree can hang WDA).
//
// Keyboards differ by text field: a comment box can add "@" and "#" keys,
// return can read "retour" or "Envoyer", dark mode changes the colours. So
// nothing is assumed: every keyboard is compared with reference screenshots,
// key by key, and only a layer that matches exactly is typed on. Each
// reference comes with its key map (labels and frames, in points), made once
// by `npm run keyboard:calibrate` and reviewed by a person: typing never
// runs OCR on keys.
//
// No reference matches (an extra key, another layout, an unknown layer):
// KeyboardLayoutMismatch, with the screenshot saved to logs/keyboard-mismatch/.
// The caller gives up typing (the comment flow closes the sheet and the feed
// goes on). Never type on a keyboard that wasn't matched.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { humanTap, type Point, type PointerAction } from './humanize.js';
import type { KeyboardDevice, KeyboardKey, KeyRect } from './typing.js';

export const KEYBOARD_DIR = new URL('./keyboards/', import.meta.url);
export const MISMATCH_DIR = path.resolve('logs/keyboard-mismatch');

/** One key of a reference layer. */
export interface ReferenceKey {
    label: string;
    /** Points. */
    rect: KeyRect;
    /**
     * Left out of the comparison: its look changes with what was typed (the
     * accent key turns ´ into `, shift lights up after "ABC"). Still a key
     * the engine can use (shift is found by its position).
     */
    volatile?: boolean;
}

export interface ReferenceLayer {
    name: string;
    keys: ReferenceKey[];
    /** Greyscale pixels of the key area (rows `top`..`bottom` of the screenshot, full width). */
    image: Buffer;
}

export interface KeyboardReference {
    name: string;
    /** Screenshot size in pixels, and points → pixels. */
    width: number;
    height: number;
    scale: number;
    /** The key area, in screenshot pixels. */
    top: number;
    bottom: number;
    layers: ReferenceLayer[];
}

/** What a reference folder's keyboard.json holds (the images are <layer>.png next to it). */
export interface KeyboardReferenceFile {
    name: string;
    width: number;
    height: number;
    scale: number;
    top: number;
    bottom: number;
    layers: Array<{ name: string; keys: ReferenceKey[] }>;
}

export class KeyboardLayoutMismatch extends Error {
    constructor(message: string, readonly screenshotPath?: string) {
        super(message);
        this.name = 'KeyboardLayoutMismatch';
    }
}

export interface Pixels { data: Buffer; width: number; height: number; channels: number }

const luminance = (data: Buffer, offset: number) => 0.299 * data[offset]! + 0.587 * data[offset + 1]! + 0.114 * data[offset + 2]!;

// ---- finding key caps ----------------------------------------------------

/** Key caps differ from the keyboard's background by at least this much (luminance). */
const CAP_CONTRAST = 18;

export interface KeyRows {
    /** Pixel rects of the key caps, by row, top to bottom and left to right. */
    rows: KeyRect[][];
    top: number;
    bottom: number;
}

/**
 * The key caps on a screenshot, in pixels, or undefined when no keyboard is
 * shown. A key row is a band of rows (lower half of the screen) where most
 * pixels stand out from the keyboard background (sampled at the left edge,
 * between the caps); the caps are the runs along a line just under the
 * band's top edge, above the labels. A keyboard has 4 such rows.
 */
export function findKeyRows({ data, width, height, channels }: Pixels, scale: number): KeyRows | undefined {
    const bands: { start: number; end: number }[] = [];
    let current: { start: number; end: number } | undefined;
    for (let y = Math.round(height * 0.45); y < height; y++) {
        const background = luminance(data, (y * width + Math.round(1.5 * scale)) * channels);
        let caps = 0;
        for (let x = 0; x < width; x += 2) {
            if (Math.abs(luminance(data, (y * width + x) * channels) - background) > CAP_CONTRAST) caps++;
        }
        if (caps / Math.ceil(width / 2) > 0.55) {
            if (current && y - current.end <= 2) current.end = y;
            else bands.push(current = { start: y, end: y });
        }
    }
    // Key caps are ~45 pt tall; shorter bands are text or bars.
    const rows = bands.filter((band) => band.end - band.start + 1 >= 30 * scale && band.end - band.start + 1 <= 60 * scale);
    if (rows.length !== 4) return undefined;
    const keyRows = rows.map((band) => {
        const y = band.start + Math.round(4 * scale);
        const background = luminance(data, (y * width + Math.round(1.5 * scale)) * channels);
        const caps: KeyRect[] = [];
        let start = -1;
        for (let x = 0; x <= width; x++) {
            const on = x < width && Math.abs(luminance(data, (y * width + x) * channels) - background) > CAP_CONTRAST;
            if (on && start < 0) start = x;
            if (!on && start >= 0) {
                if (x - start >= 10 * scale) caps.push({ x: start, y: band.start, width: x - start, height: band.end - band.start + 1 });
                start = -1;
            }
        }
        return caps;
    });
    // Every layer's top row is 10 keys of the same width (letters, digits or
    // symbols); a video grid or a list has a few wide tiles.
    const topRow = keyRows[0]!;
    const widths = topRow.map((rect) => rect.width / scale);
    if (topRow.length < 9 || Math.max(...widths) > 45 || Math.min(...widths) < Math.max(...widths) * 0.8) return undefined;
    if (keyRows.some((row) => row.length < 3)) return undefined;
    return { rows: keyRows, top: rows[0]!.start, bottom: rows.at(-1)!.end };
}

// ---- references ----------------------------------------------------------

/** Greyscale key area (rows top..bottom, full width) of a screenshot already at the reference size. */
async function keyArea(pixels: Pixels, top: number, bottom: number): Promise<Buffer> {
    return sharp(pixels.data, { raw: { width: pixels.width, height: pixels.height, channels: pixels.channels as 3 | 4 } })
        .extract({ left: 0, top, width: pixels.width, height: bottom - top + 1 }).greyscale().raw().toBuffer();
}

export async function loadKeyboardReferences(directory: URL = KEYBOARD_DIR): Promise<KeyboardReference[]> {
    const root = fileURLToPath(directory);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const references: KeyboardReference[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const folder = path.join(root, entry.name);
        const file = JSON.parse(await readFile(path.join(folder, 'keyboard.json'), 'utf8')) as KeyboardReferenceFile;
        const layers: ReferenceLayer[] = [];
        for (const layer of file.layers) {
            const image = await sharp(path.join(folder, `${layer.name}.png`)).greyscale().raw().toBuffer();
            layers.push({ ...layer, image });
        }
        references.push({ ...file, layers });
    }
    return references;
}

let cachedReferences: Promise<KeyboardReference[]> | undefined;
/** The references shipped in src/devices/keyboards/, loaded once. */
export function keyboardReferences(): Promise<KeyboardReference[]> {
    cachedReferences ??= loadKeyboardReferences();
    return cachedReferences;
}

// ---- matching --------------------------------------------------------------

/** A key differs when more than this share of its pixels differ by over KEY_PIXEL_DIFF. */
export const MAX_KEY_DIFF_SHARE = 0.03;
const KEY_PIXEL_DIFF = 60;

/** Share of the key's pixels (inset from its rounded edges) that differ from the reference. */
function keyDifference(live: Buffer, reference: Buffer, width: number, top: number, rect: KeyRect, scale: number): number {
    const inset = Math.round(3 * scale);
    const x0 = Math.round(rect.x * scale) + inset, x1 = Math.round((rect.x + rect.width) * scale) - inset;
    const y0 = Math.round(rect.y * scale) - top + inset, y1 = Math.round((rect.y + rect.height) * scale) - top - inset;
    let differ = 0, total = 0;
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            const index = y * width + x;
            total++;
            if (Math.abs(live[index]! - reference[index]!) > KEY_PIXEL_DIFF) differ++;
        }
    }
    return total ? differ / total : 1;
}

export interface KeyboardMatch {
    reference: KeyboardReference;
    layer: ReferenceLayer;
    /** The worst key's difference share (0 = identical). */
    worst: number;
    /** The keys to type on, in points. */
    keys: KeyboardKey[];
}

/**
 * The reference layer this screenshot shows, or undefined when none matches
 * every one of its keys. Screenshots of another size than a reference are
 * scaled to it first (an MJPEG frame can be smaller).
 */
export async function matchKeyboard(screenshot: Buffer, references: readonly KeyboardReference[]): Promise<KeyboardMatch | undefined> {
    let best: KeyboardMatch | undefined;
    const decoded = new Map<string, Buffer>();
    for (const reference of references) {
        const sizeKey = `${reference.width}x${reference.height}|${reference.top}-${reference.bottom}`;
        let live = decoded.get(sizeKey);
        if (!live) {
            const { data, info } = await sharp(screenshot).resize(reference.width, reference.height, { fit: 'fill' }).removeAlpha().raw()
                .toBuffer({ resolveWithObject: true });
            live = await keyArea({ data, width: info.width, height: info.height, channels: info.channels }, reference.top, reference.bottom);
            decoded.set(sizeKey, live);
        }
        for (const layer of reference.layers) {
            let worst = 0;
            for (const key of layer.keys) {
                if (key.volatile) continue;
                worst = Math.max(worst, keyDifference(live, layer.image, reference.width, reference.top, key.rect, reference.scale));
                if (worst > MAX_KEY_DIFF_SHARE) break;
            }
            if (worst <= MAX_KEY_DIFF_SHARE && (!best || worst < best.worst)) {
                best = {
                    reference, layer, worst,
                    keys: layer.keys.map((key) => ({ label: key.label, rect: key.rect })),
                };
            }
        }
    }
    return best;
}

/** Saves a keyboard no reference matched, for calibrating it (npm run keyboard:calibrate). */
export async function saveMismatch(screenshot: Buffer, directory = MISMATCH_DIR): Promise<string | undefined> {
    try {
        await mkdir(directory, { recursive: true });
        const file = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
        await writeFile(file, await sharp(screenshot).png().toBuffer());
        return file;
    } catch {
        return undefined;
    }
}

// ---- the keyboard device ----------------------------------------------------

export type KeyboardRead =
    | { state: 'matched'; match: KeyboardMatch }
    /** Keys on screen that no reference matches. */
    | { state: 'unknown'; screenshot: Buffer }
    | { state: 'closed' };

/** Reads one screenshot: a matched layer, an unknown keyboard, or no keyboard at all. */
export async function readKeyboardScreenshot(screenshot: Buffer, references: readonly KeyboardReference[], scale: number): Promise<KeyboardRead> {
    const match = await matchKeyboard(screenshot, references);
    if (match) return { state: 'matched', match };
    const { data, info } = await sharp(screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const rows = findKeyRows({ data, width: info.width, height: info.height, channels: info.channels }, scale);
    return rows ? { state: 'unknown', screenshot } : { state: 'closed' };
}

export interface ScreenKeyboardOptions {
    screenshot(): Promise<Buffer>;
    /** Points → screenshot pixels. */
    scale: number;
    perform(actions: PointerAction[]): Promise<void>;
    performSequence?(actions: PointerAction[]): Promise<boolean>;
    references?: () => Promise<KeyboardReference[]>;
    sleep?(ms: number): Promise<void>;
    /** Where a keyboard no reference matches is saved; undefined: nowhere. */
    saveMismatch?(screenshot: Buffer): Promise<string | undefined>;
}

/** An unknown keyboard is read again this many times (it may still be sliding up or switching layers). */
const UNKNOWN_RETRIES = 3;
const RETRY_MS = 300;

/**
 * The typing engine's keyboard, read off screenshots. Throws
 * KeyboardLayoutMismatch when keys are on screen but no reference matches
 * them, even after a few looks.
 */
export class ScreenKeyboard implements KeyboardDevice {
    private readonly sleep: (ms: number) => Promise<void>;
    readonly performSequence?: (actions: PointerAction[]) => Promise<boolean>;

    constructor(private readonly options: ScreenKeyboardOptions) {
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        if (options.performSequence) this.performSequence = (actions) => options.performSequence!(actions);
    }

    private async look(): Promise<KeyboardRead> {
        const references = await (this.options.references ?? keyboardReferences)();
        return readKeyboardScreenshot(await this.options.screenshot(), references, this.options.scale);
    }

    /** The matched layer's keys; [] when no keyboard is shown. */
    async readKeyboard(): Promise<KeyboardKey[]> {
        let read = await this.look();
        for (let retry = 0; read.state === 'unknown' && retry < UNKNOWN_RETRIES; retry++) {
            await this.sleep(RETRY_MS);
            read = await this.look();
        }
        if (read.state === 'matched') return read.match.keys;
        if (read.state === 'closed') return [];
        const saved = await (this.options.saveMismatch ?? saveMismatch)(read.screenshot);
        console.warn(`[keyboard] no reference keyboard matches the one on screen; giving up typing${saved ? ` (screenshot: ${saved})` : ''}`);
        throw new KeyboardLayoutMismatch(
            `The keyboard on screen matches no reference keyboard; not typing on it${saved ? ` (saved ${saved}; calibrate it with npm run keyboard:calibrate)` : ''}`,
            saved,
        );
    }

    async hasKey(label: string): Promise<boolean> {
        return (await this.readKeyboard()).some((key) => key.label === label);
    }

    perform(actions: PointerAction[]): Promise<void> {
        return this.options.perform(actions);
    }

    /** A keyboard (known or not) is on screen. */
    async visible(): Promise<boolean> {
        return (await this.look()).state !== 'closed';
    }

    /**
     * Opens the keyboard by tapping `field` (points), then waits for it to
     * slide up. Without a field the keyboard must already be open.
     */
    async open(field: Point | undefined, onTap?: (point: Point) => void): Promise<void> {
        if (await this.visible()) return;
        if (!field) throw new Error('The keyboard is not open; give the text field\'s point to tap');
        const { point, actions } = humanTap(field, { radius: 3 });
        onTap?.(point);
        await this.perform(actions);
        for (let check = 0; check < 12; check += 1) {
            await this.sleep(250);
            if (await this.visible()) {
                // Let the slide-up animation finish before matching keys.
                await this.sleep(350);
                return;
            }
        }
        throw new Error('The keyboard did not open after tapping the text field');
    }
}
