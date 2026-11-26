// Leaves a comment on the Reel on screen, for any app whose comment sheet
// exposes its text box and send button by accessibility id (Facebook,
// Instagram): tap the comment button, wait for the box, type with the human
// typing engine, tap send, check the box emptied, close the sheet.
//
// Everything is found by id (a fraction of a second each) and polled, never
// read from the full page source: with the sheet and keyboard up, one page
// source takes 4-6 s on Instagram and longer on Facebook.

import { AppStuckError } from './comment.js';
import type { AppContext } from './session.js';
import { emitTouch } from '../devices/touch-events.js';
import { swipeCoordinates, tapCoordinate } from '../tiktok/actions.js';

interface Rect { x: number; y: number; width: number; height: number }
interface Point { x: number; y: number }

export interface CommentSheetSpec {
    label: string;
    /** The comment button of the Reel on screen, or undefined when not confidently found. */
    commentButton(context: AppContext): Promise<Point | undefined>;
    /** Accessibility id of the text box at the bottom of the sheet. */
    composerId: string;
    /** Accessibility id of the send button (it may only appear once text is typed). */
    sendId: string;
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

export interface FoundElement { id: string; rect: Rect }

/** Elements with this accessibility id that are on screen (non-empty frame inside the screen). */
export async function elementsById(context: AppContext, id: string): Promise<FoundElement[]> {
    const elements = await context.driver.$$(`~${id}`);
    const found = await Promise.all(Array.from(elements, async (element) => {
        const elementId = await element.elementId;
        const rect = await context.driver.getElementRect(elementId).catch(() => undefined);
        return rect ? { id: elementId, rect } : undefined;
    }));
    const { width, height } = context.window;
    return found.filter((item): item is FoundElement => Boolean(item && item.rect.width > 0 && item.rect.height > 0
        && item.rect.x >= 0 && item.rect.y >= 0 && item.rect.x < width && item.rect.y < height));
}

/** The text box: the lowest match in the lower 70% of the screen. */
export function pickComposer(found: readonly FoundElement[], screenHeight: number): FoundElement | undefined {
    return found.filter((item) => item.rect.y > screenHeight * 0.3).sort((a, b) => b.rect.y - a.rect.y)[0];
}

/**
 * The send button on the text box's rows. Instagram also has a "send-button"
 * (share) in the Reel's column behind the sheet; that one is never taken.
 */
export function pickSend(found: readonly FoundElement[], composer: Rect): FoundElement | undefined {
    return found.find((item) => {
        const y = centre(item.rect).y;
        return y > composer.y - 30 && y < composer.y + composer.height + 30;
    });
}

async function poll<T>(timeoutMs: number, everyMs: number, read: () => Promise<T | undefined>): Promise<T | undefined> {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const value = await read().catch(() => undefined);
        if (value !== undefined || Date.now() >= until) return value;
        await sleep(everyMs);
    }
}

async function findComposer(context: AppContext, spec: CommentSheetSpec): Promise<FoundElement | undefined> {
    return pickComposer(await elementsById(context, spec.composerId), context.window.height);
}

async function onFeed(context: AppContext, spec: CommentSheetSpec): Promise<boolean> {
    if (spec.onFeed) return spec.onFeed(context).catch(() => false);
    return (await findComposer(context, spec).catch(() => ({} as FoundElement))) === undefined;
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
            field: centre(composer.rect),
            onTouch: (touch) => emitTouch(touch, { udid: context.device.udid }),
        });
        step('typing');
        console.log(`[comment] typed ${JSON.stringify(report.text)} (${report.keystrokes} taps, ${report.typos} slips)`);

        // The box may have grown with the text: find it and its send button again.
        const send = await poll(2500, 150, async () => {
            const box = await findComposer(context, spec);
            return box ? pickSend(await elementsById(context, spec.sendId), box.rect) : undefined;
        });
        if (!send) throw new Error('Typed the comment but found no send button; it was not posted');
        step('findSend');
        await sleep(between(300, 800)); // re-reading before sending
        await tapCoordinate(context.driver, centre(send.rect).x, centre(send.rect).y, 'Send comment', { radius: 3 });

        // The box empties once the app takes the comment.
        const prefix = text.slice(0, 12).toLowerCase();
        const emptied = await poll(3000, 250, async () => {
            const box = await findComposer(context, spec);
            if (!box) return true; // the sheet closed by itself
            const value = String(await context.driver.getElementAttribute(box.id, 'value') ?? '');
            return value.toLowerCase().includes(prefix) ? undefined : true;
        });
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
