// Hands-on screen tools for the MCP server: look at the phone (screenshot
// plus the text on it, read with OCR), tap, swipe. Used
// to work out a new flow on the real app (e.g. account switching) before
// it is scripted. One Appium session is kept open between calls and
// reattached when the app changes.

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import sharp from 'sharp';

import { loadRegisteredDevices } from '../devices/registry.js';
import { swipeCoordinates, tapCoordinate } from '../tiktok/actions.js';
import { describePhrases, readScreenText } from './screen-text.js';
import { AGENT_ADAPTERS } from './adapters.js';
import { connectApp, disconnectApp, resolveDevice, type AppContext } from './session.js';

const LOOK_IMAGE_WIDTH = 500;
const MAX_PHRASES = 200;

let current: { bundleId: string; udid: string; context: AppContext } | undefined;

/** `tiktok`, `facebook`, `instagram`, or a bundle id. */
export function bundleFor(app: string): string {
    return app in AGENT_ADAPTERS ? AGENT_ADAPTERS[app as keyof typeof AGENT_ADAPTERS].bundleId : app;
}

export async function exploreContext(app: string, { launch = false, udid }: { launch?: boolean; udid?: string } = {}): Promise<AppContext> {
    const bundleId = bundleFor(app);
    const device = resolveDevice(await loadRegisteredDevices(), udid);
    if (current && current.bundleId === bundleId && current.udid === device.udid && !launch) {
        // The session may have timed out between calls.
        const alive = await current.context.driver.execute('mobile: queryAppState', { bundleId }).then(() => true, () => false);
        if (alive) return current.context;
    }
    await closeExplore();
    const context = await connectApp(device, bundleId, { launch });
    current = { bundleId, udid: device.udid, context };
    return context;
}

export async function closeExplore(): Promise<boolean> {
    const open = current;
    current = undefined;
    if (!open) return false;
    await disconnectApp(open.context);
    return true;
}

export async function look(context: AppContext, { words = true }: { words?: boolean } = {}) {
    const screenshot = await context.screenshot();
    const image = await sharp(screenshot).resize({ width: LOOK_IMAGE_WIDTH }).jpeg({ quality: 70 }).toBuffer();
    let text = `screen ${context.window.width}x${context.window.height} points (image is ${LOOK_IMAGE_WIDTH}px wide: multiply image px by ${(context.window.width / LOOK_IMAGE_WIDTH).toFixed(3)} for points)`;
    if (words) {
        try {
            const lines = describePhrases(await readScreenText(screenshot, context.scale));
            text += `\n${lines.length} text phrases (OCR, centre and size in points)${lines.length > MAX_PHRASES ? ` (first ${MAX_PHRASES})` : ''}:\n${lines.slice(0, MAX_PHRASES).join('\n')}`;
        } catch (error) {
            text += `\n(no OCR text: ${error instanceof Error ? error.message : String(error)})`;
        }
    }
    return { image, text };
}

/** Writes a full-resolution screenshot to `path` (PNG or JPEG by extension); returns where, its size and a small preview. */
export async function saveScreenshot(context: AppContext, path: string) {
    const format = /\.jpe?g$/i.test(path) ? 'jpeg' : /\.png$/i.test(path) ? 'png' : undefined;
    if (!format) throw new Error(`Screenshot path must end in .png or .jpg: ${path}`);
    const screenshot = sharp(await context.screenshot());
    const file = resolve(path);
    await mkdir(dirname(file), { recursive: true });
    const { width, height } = await (format === 'png' ? screenshot.clone().png() : screenshot.clone().jpeg({ quality: 95 })).toFile(file);
    const preview = await screenshot.resize({ width: LOOK_IMAGE_WIDTH }).jpeg({ quality: 70 }).toBuffer();
    return { path: file, width, height, preview };
}

export async function tap(context: AppContext, x: number, y: number, label = 'explore tap'): Promise<void> {
    await tapCoordinate(context.driver, x, y, label, { radius: 3 });
}

export async function swipe(context: AppContext, from: { x: number; y: number }, to: { x: number; y: number }, durationMs = 450): Promise<void> {
    await swipeCoordinates(context.driver, from, to, durationMs);
}
