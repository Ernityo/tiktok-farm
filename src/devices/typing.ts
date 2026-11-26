// Human-like typing on the iPhone's on-screen keyboard: every character is a
// real tap on its key, with the rhythm of a person typing with a thumb.
//
// The keyboard is read from the device (key labels + frames), never assumed,
// so it works with any layout (QWERTY, AZERTY…) and any iPhone size. Layer
// changes (shift, "123", "#+=") are found by position, which iOS keeps the
// same in every language:
//
//   row above space:  [shift | #+= | 123]  letters…  [delete]
//   bottom row:       [123 | ABC]  …  [space (widest)]  …  [return]
//
// Timing (down-to-down between key presses) follows what studies of phone
// typing report — around 30–45 WPM for a casual one-thumb typist:
//   • far keys take longer than near ones (Fitts' law on the thumb's travel),
//   • every interval varies (log-normal), presses are short and uneven,
//   • a small pause before each new word, a longer one after a sentence, and
//     now and then a "thinking" pause,
//   • a visual-search pause after switching to the numbers/symbols layer,
//   • occasional slips onto a neighbouring key, noticed a key or two later,
//     deleted and retyped.
//
// Each key is its own tap request, sent at its planned time. Before each
// word the keyboard's state is checked, because iOS
// changes layers on its own (auto-capitals after ". ", back to letters after
// a symbol and space…).

import type { Point, PointerAction, Random } from './humanize.js';

export interface KeyRect { x: number; y: number; width: number; height: number }

export interface KeyboardKey { label: string; rect: KeyRect }

export interface KeyboardLayer {
    keys: KeyboardKey[];
    /** Keys grouped into rows, top to bottom, each left to right. */
    rows: KeyboardKey[][];
    /** 'lower'/'upper': a letters layer and its case. 'other': numbers, symbols… */
    kind: 'lower' | 'upper' | 'other';
    signature: string;
}

/** What the typing engine needs from a device. */
export interface KeyboardDevice {
    /** The keys currently on screen (empty when no keyboard is shown). */
    readKeyboard(): Promise<KeyboardKey[]>;
    /** Whether a key with exactly this label is on screen right now. */
    hasKey(label: string): Promise<boolean>;
    /** Perform pointer actions; resolves once they have been performed. */
    perform(actions: PointerAction[]): Promise<void>;
    /**
     * Perform several separate taps in one go (each pointerDown..pointerUp its
     * own touch), timed by the pauses between them. Resolves false when the
     * device can't (then taps go one per perform call).
     */
    performSequence?(actions: PointerAction[]): Promise<boolean>;
}

export interface TypingOptions {
    /** Typing speed in words per minute. Default: a random 28–44 per call. */
    wpm?: number;
    /** Chance (0–1) that a letter slips onto a neighbouring key and gets corrected. Default 0.02. */
    typoRate?: number;
    /** Called when each key is pressed (for the live overlay). */
    onTap?(point: Point): void;
    random?: Random;
    sleep?(ms: number): Promise<void>;
    now?(): number;
}

export interface TypingReport {
    text: string;
    keystrokes: number;
    typos: number;
    durationMs: number;
    wpm: number;
}

/**
 * Keyboard layers already read on one keyboard (same phone, same keyboard
 * frame). A full read costs a page-source request, seconds on a busy app;
 * the layout never changes, so later reads only confirm which known layer
 * is up with one key lookup.
 */
export interface KeyboardLayerCache { layers: KeyboardKey[][] }

/** A label found on this layer and on no other known one, to tell it apart with one lookup. */
function markerLabel(keys: readonly KeyboardKey[], others: readonly KeyboardKey[][]): string | undefined {
    const elsewhere = new Set(others.flatMap((layer) => layer.map((key) => key.label)));
    // Letters and digits first: nothing else on screen is labelled "a" or "1".
    const candidates = keys.map((key) => key.label).filter((label) => singleChar(label) && !elsewhere.has(label));
    return candidates.find((label) => /^[\p{L}\p{N}]$/u.test(label)) ?? candidates[0];
}

/** Wraps a keyboard so each layer is read in full once, then recognised from the cache. */
export function cachedKeyboard(device: KeyboardDevice, cache: KeyboardLayerCache): KeyboardDevice {
    return {
        hasKey: (label) => device.hasKey(label),
        perform: (actions) => device.perform(actions),
        ...(device.performSequence ? { performSequence: (actions: PointerAction[]) => device.performSequence!(actions) } : {}),
        async readKeyboard() {
            for (const [index, keys] of cache.layers.entries()) {
                const marker = markerLabel(keys, cache.layers.filter((_, other) => other !== index));
                if (marker && await device.hasKey(marker)) return keys;
            }
            const keys = await device.readKeyboard();
            if (keys.length) {
                const signature = describeKeyboard(keys).signature;
                if (!cache.layers.some((layer) => describeKeyboard(layer).signature === signature)) cache.layers.push(keys);
            }
            return keys;
        },
    };
}

export const MAX_TYPING_LENGTH = 1000;
/** Most keys planned at once before re-checking the keyboard. */
const MAX_STROKES_PER_SEND = 18;

// ---- randomness --------------------------------------------------------

function gaussian(random: Random): number {
    const u = Math.max(random(), Number.EPSILON);
    const v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function uniform(min: number, max: number, random: Random): number {
    return min + random() * (max - min);
}

function logNormal(median: number, sigma: number, random: Random): number {
    return median * Math.exp(sigma * gaussian(random));
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

// ---- keyboard model ----------------------------------------------------

function center(rect: KeyRect): Point {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function isLetter(char: string): boolean {
    return /^\p{L}$/u.test(char);
}

function isUpper(char: string): boolean {
    return char !== char.toLowerCase() && char === char.toUpperCase();
}

function singleChar(label: string): boolean {
    return Array.from(label).length === 1;
}

export function describeKeyboard(keys: readonly KeyboardKey[]): KeyboardLayer {
    const usable = keys.filter((key) => key.rect.width > 0 && key.rect.height > 0);
    const sorted = [...usable].sort((a, b) => center(a.rect).y - center(b.rect).y);
    const rows: KeyboardKey[][] = [];
    for (const key of sorted) {
        const row = rows.at(-1);
        const cy = center(key.rect).y;
        if (row && Math.abs(center(row[0].rect).y - cy) < Math.min(row[0].rect.height, key.rect.height) / 2) {
            row.push(key);
        } else {
            rows.push([key]);
        }
    }
    for (const row of rows) row.sort((a, b) => a.rect.x - b.rect.x);

    const letters = usable.filter((key) => singleChar(key.label) && isLetter(key.label));
    let kind: KeyboardLayer['kind'] = 'other';
    if (letters.length >= 15) {
        const upper = letters.filter((key) => isUpper(key.label)).length;
        kind = upper > letters.length / 2 ? 'upper' : 'lower';
    }
    const signature = usable.map((key) => key.label).sort().join('\u0000');
    return { keys: usable, rows, kind, signature };
}

/** The space bar: the widest key on the keyboard. */
export function spaceKey(layer: KeyboardLayer): KeyboardKey | undefined {
    return layer.keys.reduce<KeyboardKey | undefined>((widest, key) => (!widest || key.rect.width > widest.rect.width ? key : widest), undefined);
}

function spaceRowIndex(layer: KeyboardLayer): number {
    const space = spaceKey(layer);
    return space ? layer.rows.findIndex((row) => row.includes(space)) : -1;
}

/** Leftmost key of the space bar's row: "123" on letters, "ABC" on numbers/symbols. */
export function layerToggleKey(layer: KeyboardLayer): KeyboardKey | undefined {
    const index = spaceRowIndex(layer);
    const row = layer.rows[index];
    return row && row[0] !== spaceKey(layer) ? row[0] : undefined;
}

/** Rightmost key of the space bar's row. */
export function returnKey(layer: KeyboardLayer): KeyboardKey | undefined {
    const index = spaceRowIndex(layer);
    const row = layer.rows[index];
    const last = row?.at(-1);
    return last && last !== spaceKey(layer) ? last : undefined;
}

/** Leftmost key of the row above the space bar: shift on letters, "#+=" / "123" elsewhere. */
export function shiftKey(layer: KeyboardLayer): KeyboardKey | undefined {
    const index = spaceRowIndex(layer);
    return index > 0 ? layer.rows[index - 1][0] : undefined;
}

/** Rightmost key of the row above the space bar: delete. */
export function deleteKey(layer: KeyboardLayer): KeyboardKey | undefined {
    const index = spaceRowIndex(layer);
    return index > 0 ? layer.rows[index - 1].at(-1) : undefined;
}

// Keyboards in many languages only have the typographic variant.
const ALIASES: Record<string, string[]> = { "'": ['’'], '’': ["'"], '"': ['”', '“'] };

export function keyForChar(layer: KeyboardLayer, char: string): KeyboardKey | undefined {
    if (char === ' ') return spaceKey(layer);
    if (char === '\n') return returnKey(layer);
    for (const candidate of [char, ...(ALIASES[char] ?? [])]) {
        const key = layer.keys.find((item) => item.label === candidate && singleChar(item.label));
        if (key) return key;
    }
    return;
}

/** The key to press to get closer to a layer that has `char`. */
function navigationKey(layer: KeyboardLayer, char: string): KeyboardKey | undefined {
    if (isLetter(char)) {
        if (layer.kind === 'other') return layerToggleKey(layer);
        if ((layer.kind === 'upper') !== isUpper(char)) return shiftKey(layer);
        return; // a letter this keyboard doesn't have (é on QWERTY…)
    }
    return layer.kind === 'other' ? shiftKey(layer) : layerToggleKey(layer);
}

/** Letter keys right around `key` — where a thumb lands when it slips. */
function neighbours(layer: KeyboardLayer, key: KeyboardKey): KeyboardKey[] {
    const from = center(key.rect);
    return layer.keys.filter((other) => {
        if (other === key || !singleChar(other.label) || !isLetter(other.label)) return false;
        const to = center(other.rect);
        return Math.abs(to.y - from.y) < key.rect.height * 0.5 && Math.abs(to.x - from.x) < key.rect.width * 1.4;
    });
}

// ---- timing ------------------------------------------------------------

/** Where a thumb actually presses inside a key: near the centre, a touch low. */
export function keyPressPoint(rect: KeyRect, random: Random = Math.random): Point {
    const c = center(rect);
    const dx = clamp(gaussian(random) * rect.width * 0.14, -rect.width * 0.38, rect.width * 0.38);
    const dy = clamp(rect.height * 0.06 + gaussian(random) * rect.height * 0.12, -rect.height * 0.35, rect.height * 0.35);
    return { x: Math.round(c.x + dx), y: Math.round(c.y + dy) };
}

/** How long the key is held down. Keyboard presses are short. */
export function keyHoldMs(random: Random = Math.random): number {
    return Math.round(clamp(logNormal(82, 0.22, random), 45, 160));
}

/**
 * Down-to-down time between two key presses at a given speed: longer for
 * keys further apart (Fitts' law), always a little different.
 */
export function keyIntervalMs(from: Point | undefined, to: Point, keyWidth: number, wpm: number, random: Random = Math.random): number {
    const mean = 60_000 / (wpm * 5);
    if (!from) return Math.round(mean);
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const difficulty = Math.log2(distance / Math.max(keyWidth, 1) + 1);
    return Math.round(clamp(mean * (0.4 + 0.18 * difficulty) * logNormal(1, 0.25, random), 70, 1500));
}

/** Extra pause before the first key of a word. */
export function wordPauseMs(afterSentence: boolean, random: Random = Math.random): number {
    let ms = logNormal(130, 0.5, random);
    if (afterSentence) ms += uniform(250, 700, random);
    if (random() < 0.06) ms += uniform(500, 1600, random); // stops to think
    return Math.round(ms);
}

export function sampleWpm(random: Random = Math.random): number {
    return Math.round(uniform(28, 44, random));
}

// ---- engine ------------------------------------------------------------

interface Stroke { key: KeyboardKey; gapMs: number }

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Type `text` on the keyboard currently shown on the device, tapping every
 * key like a person would. The keyboard must already be open.
 */
export async function typeOnKeyboard(device: KeyboardDevice, text: string, options: TypingOptions = {}): Promise<TypingReport> {
    const random = options.random ?? Math.random;
    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? Date.now;
    const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
    const wpm = clamp(finite(options.wpm) ? options.wpm : sampleWpm(random), 5, 120);
    const typoRate = clamp(finite(options.typoRate) ? options.typoRate : 0.02, 0, 0.3);
    const chars = Array.from(text);
    if (!chars.length) throw new Error('Nothing to type');
    if (chars.length > MAX_TYPING_LENGTH) throw new Error(`Text is too long to type (max ${MAX_TYPING_LENGTH} characters)`);

    let layer = describeKeyboard(await device.readKeyboard());
    if (!layer.keys.length) throw new Error('The keyboard is not open');

    const startedAt = now();
    let lastPoint: Point | undefined;
    let lastDownAt = startedAt;
    // Glance at the keyboard before the first key.
    let pendingGap = Math.round(uniform(350, 850, random));
    let keystrokes = 0;
    let typos = 0;

    const keyWidth = () => {
        const letters = layer.keys.filter((key) => singleChar(key.label));
        return letters.length ? Math.min(...letters.map((key) => key.rect.width)) : 30;
    };

    // A word goes to the device as one tap sequence when it can play one:
    // the gaps and holds are inside the request, so request latency (~300 ms
    // a call) is paid once per word instead of once per key.
    let sequences = Boolean(device.performSequence);
    const sendSequence = async (strokes: Stroke[]): Promise<boolean> => {
        const wait = lastDownAt + strokes[0].gapMs - now();
        if (wait > 0) await sleep(wait);
        const actions: PointerAction[] = [];
        const taps: Array<{ at: number; point: Point }> = [];
        let at = 0;
        let previousHold = 0;
        strokes.forEach((stroke, index) => {
            const point = keyPressPoint(stroke.key.rect, random);
            const hold = keyHoldMs(random);
            if (index > 0) {
                // Down-to-down gap, minus the previous key's hold: the finger is up in between.
                const pause = Math.max(15, stroke.gapMs - previousHold);
                actions.push({ type: 'pause', duration: pause });
                at += previousHold + pause;
            }
            actions.push(
                { type: 'pointerMove', duration: 0, x: point.x, y: point.y },
                { type: 'pointerDown', button: 0 },
                { type: 'pause', duration: hold },
                { type: 'pointerUp', button: 0 },
            );
            taps.push({ at, point });
            previousHold = hold;
        });
        const startedSequence = now();
        // The live overlay shows each tap when it lands.
        const timers = options.onTap ? taps.map(({ at: offset, point }) => setTimeout(() => options.onTap?.(point), offset)) : [];
        const played = await device.performSequence!(actions);
        if (!played) {
            timers.forEach(clearTimeout);
            return false;
        }
        lastDownAt = startedSequence + (taps.at(-1)?.at ?? 0);
        lastPoint = taps.at(-1)?.point;
        keystrokes += strokes.length;
        return true;
    };

    // Otherwise one tap per request, each at its planned time. Request latency
    // is about constant, so the gaps between presses survive it.
    const send = async (strokes: Stroke[]): Promise<void> => {
        if (!strokes.length) return;
        if (sequences && strokes.length > 1) {
            if (await sendSequence(strokes)) return;
            sequences = false;
        }
        for (const stroke of strokes) {
            const point = keyPressPoint(stroke.key.rect, random);
            const hold = keyHoldMs(random);
            const wait = lastDownAt + stroke.gapMs - now();
            if (wait > 0) await sleep(wait);
            lastDownAt = now();
            options.onTap?.(point);
            await device.perform([
                { type: 'pointerMove', duration: 0, x: point.x, y: point.y },
                { type: 'pointerDown', button: 0 },
                { type: 'pause', duration: hold },
                { type: 'pointerUp', button: 0 },
            ]);
            lastPoint = point;
            keystrokes += 1;
        }
    };

    const gapTo = (key: KeyboardKey, from: Point | undefined, extra: number) =>
        keyIntervalMs(from, center(key.rect), keyWidth(), wpm, random) + extra;

    // A lowercase letter starting a word mid-sentence on the lowercase layer:
    // iOS has no reason to have switched layers, so skip the round trip that
    // checks (one per word otherwise). After ". " iOS capitalizes by itself,
    // and the first letter may be auto-capitalized too: those still check.
    let typed = 0;
    const trustLayer = (char: string): boolean => {
        if (layer.kind !== 'lower' || !isLetter(char) || isUpper(char) || typed === 0) return false;
        const before = chars.slice(Math.max(0, typed - 3), typed).join('');
        return /[^.!?\s]\s$/.test(before);
    };

    // Finds `char` on the keyboard, switching layers if needed.
    const locate = async (char: string): Promise<KeyboardKey> => {
        const cached = keyForChar(layer, char);
        if (cached && (char === ' ' || char === '\n' || trustLayer(char) || await device.hasKey(cached.label))) return cached;
        layer = describeKeyboard(await device.readKeyboard());
        const seen = new Set<string>();
        for (let step = 0; step < 4; step += 1) {
            const key = keyForChar(layer, char);
            if (key) return key;
            const toggle = navigationKey(layer, char);
            if (!toggle || seen.has(layer.signature)) break;
            seen.add(layer.signature);
            await send([{ key: toggle, gapMs: gapTo(toggle, lastPoint, pendingGap) }]);
            // Looking for the next key on the new layer.
            pendingGap = isLetter(char) ? Math.round(uniform(40, 140, random)) : Math.round(uniform(180, 450, random));
            layer = describeKeyboard(await device.readKeyboard());
            if (!layer.keys.length) throw new Error('The keyboard closed while typing');
        }
        const shown = JSON.stringify(char);
        throw new Error(`Cannot type ${shown}: it is not on this keyboard`);
    };

    let index = 0;
    while (index < chars.length) {
        typed = index;
        const first = await locate(chars[index]);
        const strokes: Stroke[] = [];
        let from = lastPoint;
        const push = (key: KeyboardKey, extra = 0) => {
            strokes.push({ key, gapMs: gapTo(key, from, extra) });
            from = center(key.rect);
        };

        let firstInChunk = true;
        while (index < chars.length && strokes.length < MAX_STROKES_PER_SEND) {
            const char = chars[index];
            const key = firstInChunk ? first : keyForChar(layer, char);
            if (!key) break;
            const previous = chars[index - 1];
            const extra = firstInChunk ? pendingGap : 0;
            const wordStart = previous !== undefined && /\s/.test(previous) && !/\s/.test(char);
            const pause = wordStart ? wordPauseMs(/[.!?]/.test(chars[index - 2] ?? ''), random) : 0;

            const slip = !firstInChunk && layer.kind === 'lower' && isLetter(char) && !isUpper(char) && random() < typoRate
                ? neighbours(layer, key) : [];
            const backspace = deleteKey(layer);
            const following: KeyboardKey[] = [];
            if (slip.length && backspace) {
                const extraKeys = Math.floor(random() * 3);
                for (let ahead = 1; ahead <= extraKeys; ahead += 1) {
                    const next = chars[index + ahead];
                    const nextKey = next !== undefined && isLetter(next) && !isUpper(next) ? keyForChar(layer, next) : undefined;
                    if (!nextKey) break;
                    following.push(nextKey);
                }
            }
            // A slip costs wrong keys + as many deletes + the retyped keys.
            if (slip.length && backspace && strokes.length + 3 * (following.length + 1) <= MAX_STROKES_PER_SEND) {
                // Hit a neighbour, carry on for a key or two, notice, fix it.
                const wrong = slip[Math.floor(random() * slip.length)];
                push(wrong, extra + pause);
                for (const nextKey of following) push(nextKey);
                for (let n = 0; n <= following.length; n += 1) {
                    strokes.push({ key: backspace, gapMs: n === 0 ? Math.round(uniform(250, 650, random)) : Math.round(clamp(logNormal(165, 0.2, random), 90, 320)) });
                    from = center(backspace.rect);
                }
                push(key, Math.round(uniform(80, 220, random)));
                for (const nextKey of following) push(nextKey);
                index += following.length + 1;
                typos += 1;
            } else {
                push(key, extra + pause);
                index += 1;
            }
            firstInChunk = false;
            pendingGap = 0;
            // iOS may change layer by itself after these, so re-check first.
            const ends = char === ' ' || char === '\n' || layer.kind === 'upper' || (!isLetter(char) && !/^\p{N}$/u.test(char));
            if (ends) break;
        }
        await send(strokes);
    }

    const durationMs = Math.max(1, now() - startedAt);
    return { text, keystrokes, typos, durationMs, wpm: Math.round((chars.length / 5) / (durationMs / 60_000)) };
}
