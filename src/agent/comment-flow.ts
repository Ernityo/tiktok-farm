// Leaves a comment on the Reel on screen (Facebook, Instagram): tap the
// comment button, wait for the text box, type with the human typing engine,
// tap send, check the box emptied, close the sheet.
//
// Everything is read off screenshots, never the accessibility tree (with the
// sheet and keyboard up, one page source took 4-6 s on Instagram, longer on
// Facebook): the empty box by its placeholder text (OCR), the send button by
// its colour (a blue button right of the box once text is typed).

import sharp from 'sharp';

import { AppStuckError } from './comment.js';
import { isNoise, mergePasses } from './screen-text.js';
import type { AppContext } from './session.js';
import { emitTouch } from '../devices/touch-events.js';
import { swipeCoordinates, tapCoordinate } from '../tiktok/actions.js';
import { recognizeWords, type OcrWord } from '../tiktok/ocr.js';

interface Rect { x: number; y: number; width: number; height: number }
interface Point { x: number; y: number }

export interface CommentSheetSpec {
    label: string;
    /** The comment button of the Reel on screen, or undefined when not confidently found. */
    commentButton(context: AppContext): Promise<Point | undefined>;
    /** The empty text box's placeholder ("Rejoignez la conversation…"), matched on its OCR'd line. */
    placeholder: RegExp;
    /** Back on the Reel. Defaults to: the text box is gone. */
    onFeed?(context: AppContext): Promise<boolean>;
}

export interface CommentOutcome {
    text: string;
    /** The text box emptied after send, i.e. the app took the comment. */
    verified: boolean;
    durationMs: number;
    /** Time per step, for tuning. */
    steps: Record<string, number>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
const between = (min: number, max: number) => Math.round(min + Math.random() * (max - min));
const centre = (rect: Rect): Point => ({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });

/** Where the sheet's text box can be: below the video, above the home indicator (shares of the height). */
const SHEET_BAND = { top: 0.3, bottom: 0.97 } as const;

/**
 * OCR words of the sheet's lower part (screenshot pixels), dark text on light
 * and light text on dark (Instagram's sheet is dark, Facebook's light).
 */
export async function readSheetWords(screenshot: Buffer): Promise<OcrWord[]> {
    const { width = 0, height = 0 } = await sharp(screenshot).metadata();
    const top = Math.round(height * SHEET_BAND.top);
    const crop = sharp(screenshot).extract({ left: 0, top, width, height: Math.round(height * SHEET_BAND.bottom) - top }).greyscale();
    const passes = await Promise.all([
        recognizeWords(await crop.clone().withMetadata({ density: 300 }).png().toBuffer()),
        recognizeWords(await crop.clone().negate({ alpha: false }).withMetadata({ density: 300 }).png().toBuffer()),
    ]);
    return mergePasses(passes.map((pass) => pass.filter((word) => !isNoise(word)))).map((word) => ({ ...word, y: word.y + top }));
}

/**
 * The empty text box: the lowest line of words matching the placeholder, as
 * a rect in points (the placeholder text, inside the box). Undefined when
 * there's no empty box on screen (typed text, sheet closed).
 */
export function findPlaceholder(words: readonly OcrWord[], placeholder: RegExp, scale: number): Rect | undefined {
    const lines: OcrWord[][] = [];
    for (const word of [...words].sort((a, b) => a.y - b.y)) {
        const line = lines.find((candidate) => Math.abs(candidate[0]!.y + candidate[0]!.height / 2 - (word.y + word.height / 2)) < Math.max(candidate[0]!.height, word.height) * 0.6);
        if (line) line.push(word);
        else lines.push([word]);
    }
    const matching = lines.filter((line) => placeholder.test(line.sort((a, b) => a.x - b.x).map((word) => word.text).join(' ')));
    const line = matching.at(-1);
    if (!line) return undefined;
    const left = Math.min(...line.map((w) => w.x)), right = Math.max(...line.map((w) => w.x + w.width));
    const top = Math.min(...line.map((w) => w.y)), bottom = Math.max(...line.map((w) => w.y + w.height));
    return { x: left / scale, y: top / scale, width: (right - left) / scale, height: (bottom - top) / scale };
}

/** The send buttons' blue: Instagram (68, 94, 251), Facebook (10, 102, 247). Not cyan video. */
const isSendBlue = (r: number, g: number, b: number) => b > 215 && r < 110 && g < 135 && b - g > 110;

/**
 * The send button in raw pixels: the biggest compact blob of send-blue in
 * the right quarter of the sheet band, 12-60 pt across (Instagram's pill is
 * 49 × 32 pt), whole inside that quarter (a blob cut by its left edge is
 * something wider, like a chat bubble in a video). Undefined when there is
 * none (nothing typed yet, or the sheet is gone).
 */
export function findSendButton(data: Buffer, width: number, height: number, channels: number, scale: number): Point | undefined {
    const x0 = Math.round(width * 0.75), y0 = Math.round(height * SHEET_BAND.top), y1 = Math.round(height * SHEET_BAND.bottom);
    const w = width - x0, h = y1 - y0;
    const blue = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const o = ((y + y0) * width + x + x0) * channels;
            if (isSendBlue(data[o]!, data[o + 1]!, data[o + 2]!)) blue[y * w + x] = 1;
        }
    }
    let best: { count: number; cx: number; cy: number } | undefined;
    const stack: number[] = [];
    for (let start = 0; start < blue.length; start++) {
        if (blue[start] !== 1) continue;
        blue[start] = 2;
        stack.push(start);
        let count = 0, sx = 0, sy = 0, minX = w, maxX = 0, minY = h, maxY = 0;
        while (stack.length) {
            const index = stack.pop()!;
            const x = index % w, y = (index - x) / w;
            count++; sx += x; sy += y;
            minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            for (const next of [index - 1, index + 1, index - w, index + w]) {
                if (next < 0 || next >= blue.length || blue[next] !== 1) continue;
                if ((next === index - 1 && x === 0) || (next === index + 1 && x === w - 1)) continue;
                blue[next] = 2;
                stack.push(next);
            }
        }
        const across = Math.max(maxX - minX + 1, maxY - minY + 1) / scale;
        // Both buttons are at least ~20 pt each way (Facebook 20 × 22, Instagram 49 × 32); other blue in a video comes in thin fragments.
        const narrow = Math.min(maxX - minX + 1, maxY - minY + 1) / scale;
        const fill = count / ((maxX - minX + 1) * (maxY - minY + 1));
        if (minX === 0 || across < 12 || across > 60 || narrow < 15 || fill < 0.3) continue;
        if (!best || count > best.count) best = { count, cx: x0 + sx / count, cy: y0 + sy / count };
    }
    return best ? { x: Math.round(best.cx), y: Math.round(best.cy) } : undefined;
}

async function findComposer(context: AppContext, spec: CommentSheetSpec): Promise<Rect | undefined> {
    return findPlaceholder(await readSheetWords(await context.screenshot()), spec.placeholder, context.scale);
}

async function findSend(context: AppContext): Promise<Point | undefined> {
    const { data, info } = await sharp(await context.screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const point = findSendButton(data, info.width, info.height, info.channels, context.scale);
    return point && { x: Math.round(point.x / context.scale), y: Math.round(point.y / context.scale) };
}

async function poll<T>(timeoutMs: number, everyMs: number, read: () => Promise<T | undefined>): Promise<T | undefined> {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const value = await read().catch(() => undefined);
        if (value !== undefined || Date.now() >= until) return value;
        await sleep(everyMs);
    }
}

async function onFeed(context: AppContext, spec: CommentSheetSpec): Promise<boolean> {
    if (spec.onFeed) return spec.onFeed(context).catch(() => false);
    return (await findComposer(context, spec).catch(() => ({} as Rect))) === undefined;
}

/**
 * Closes the sheet: swipes down (the first may only drop the keyboard), then
 * a tap on the dimmed Reel above it. Throws AppStuckError when the Reel
 * doesn't come back: the feed can't go on from inside the sheet.
 */
export async function closeCommentSheet(context: AppContext, spec: CommentSheetSpec): Promise<void> {
    const { width, height } = context.window;
    const down = (fromY: number) => () => swipeCoordinates(context.driver, { x: width * 0.5, y: height * fromY }, { x: width * 0.5, y: height * 0.95 }, 260);
    const attempts = [
        down(0.35),
        down(0.4),
        () => tapCoordinate(context.driver, width * 0.5, height * 0.1, 'above the comment sheet', { radius: 12 }),
    ];
    for (const attempt of attempts) {
        await attempt();
        if (await poll(1200, 200, async () => ((await onFeed(context, spec)) ? true : undefined))) return;
    }
    throw new AppStuckError(`Could not close the ${spec.label} comment sheet; the feed cannot go on`);
}

/**
 * Leaves `text` (already sanitized: one line, typeable) as a comment on the
 * Reel on screen. Throws a plain Error when it couldn't (after closing the
 * sheet), or AppStuckError when the Reel can't be brought back.
 */
export async function leaveComment(context: AppContext, spec: CommentSheetSpec, text: string): Promise<CommentOutcome> {
    const started = Date.now();
    const steps: Record<string, number> = {};
    let mark = started;
    const step = (name: string) => {
        const now = Date.now();
        steps[name] = now - mark;
        mark = now;
    };

    const button = await spec.commentButton(context);
    if (!button) throw new Error('Comment skipped: the comment button was not found confidently');
    await tapCoordinate(context.driver, button.x, button.y, 'Comment', { radius: 4 });
    step('openTap');
    let opened = false;
    try {
        const composer = await poll(5000, 150, () => findComposer(context, spec));
        if (!composer) throw new Error(`The ${spec.label} comment sheet did not open (no text box found)`);
        opened = true;
        step('sheetOpen');
        // A glance at the other comments before writing.
        await sleep(between(800, 2200));
        step('readPause');

        const report = await context.remoteControl.typeText(context.device.udid, text, {
            field: centre(composer),
            onTouch: (touch) => emitTouch(touch, { udid: context.device.udid }),
        });
        step('typing');
        console.log(`[comment] typed ${JSON.stringify(report.text)} (${report.keystrokes} taps, ${report.typos} slips)`);

        // The send button shows once there's text in the box.
        const send = await poll(2500, 200, () => findSend(context));
        if (!send) throw new Error('Typed the comment but found no send button; it was not posted');
        step('findSend');
        await sleep(between(300, 800)); // re-reading before sending
        await tapCoordinate(context.driver, send.x, send.y, 'Send comment', { radius: 3 });

        // The box empties once the app takes the comment: the placeholder is back.
        const emptied = await poll(3000, 250, async () => ((await findComposer(context, spec)) ? true : undefined));
        const verified = emptied === true;
        step('send');
        if (!verified) console.log('[comment] the text box did not empty after send; the comment may not have been posted');
        await sleep(between(500, 1500)); // a look at the posted comment
        await closeCommentSheet(context, spec);
        step('close');
        return { text, verified, durationMs: Date.now() - started, steps };
    } catch (error) {
        // Put the Reel back. Also when the sheet seemed not to open: the tap may have opened something else.
        if (!(error instanceof AppStuckError) && (opened || !(await onFeed(context, spec)))) await closeCommentSheet(context, spec);
        throw error;
    }
}
