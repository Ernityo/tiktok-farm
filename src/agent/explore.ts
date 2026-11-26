// Hands-on screen tools for the MCP server: look at the phone (screenshot
// plus the labelled elements of the accessibility tree), tap, swipe. Used
// to work out a new flow on the real app (e.g. account switching) before
// it is scripted. One Appium session is kept open between calls and
// reattached when the app changes.

import sharp from 'sharp';

import { loadRegisteredDevices } from '../devices/registry.js';
import { swipeCoordinates, tapCoordinate } from '../tiktok/actions.js';
import type { SourceNode } from '../instagram/reels-screen.js';
import { readSource } from './page-source.js';
import { AGENT_ADAPTERS } from './adapters.js';
import { connectApp, resolveDevice, type AppContext } from './session.js';

const LOOK_IMAGE_WIDTH = 500;
const MAX_ELEMENTS = 200;

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
    await open.context.driver.deleteSession().catch(() => undefined);
    return true;
}

const visible = (node: SourceNode) => node.isVisible === true || node.isVisible === '1';
const clean = (text: string | null | undefined) => (text ?? '').replace(/[  ‎]/g, ' ').trim();

/** One line per visible element that carries text: type, label/name/value, centre and size in points. */
export function describeElements(root: SourceNode, window: { width: number; height: number }): string[] {
    const lines: string[] = [];
    const walk = (node: SourceNode) => {
        const label = clean(node.label);
        const name = clean(node.name);
        const value = clean(node.value);
        const rect = node.rect;
        const onScreen = rect && rect.width > 0 && rect.height > 0
            && rect.x < window.width && rect.y < window.height && rect.x + rect.width > 0 && rect.y + rect.height > 0;
        if (visible(node) && onScreen && (label || name || value)) {
            const text = [
                label ? JSON.stringify(label) : '',
                name && name !== label ? `name=${JSON.stringify(name)}` : '',
                value && value !== label ? `value=${JSON.stringify(value)}` : '',
            ].filter(Boolean).join(' ');
            const cx = Math.round(rect.x + rect.width / 2);
            const cy = Math.round(rect.y + rect.height / 2);
            lines.push(`${(node.type ?? '').replace(/^XCUIElementType/, '')} ${text} @(${cx},${cy}) ${Math.round(rect.width)}x${Math.round(rect.height)}`);
        }
        for (const child of node.children ?? []) walk(child);
    };
    walk(root);
    return lines;
}

export async function look(context: AppContext, { elements = true }: { elements?: boolean } = {}) {
    const screenshot = await context.screenshot();
    const image = await sharp(screenshot).resize({ width: LOOK_IMAGE_WIDTH }).jpeg({ quality: 70 }).toBuffer();
    let text = `screen ${context.window.width}x${context.window.height} points (image is ${LOOK_IMAGE_WIDTH}px wide: multiply image px by ${(context.window.width / LOOK_IMAGE_WIDTH).toFixed(3)} for points)`;
    if (elements) {
        try {
            const lines = describeElements(await readSource(context), context.window);
            text += `\n${lines.length} labelled elements${lines.length > MAX_ELEMENTS ? ` (first ${MAX_ELEMENTS})` : ''}:\n${lines.slice(0, MAX_ELEMENTS).join('\n')}`;
        } catch (error) {
            text += `\n(no element list: ${error instanceof Error ? error.message : String(error)})`;
        }
    }
    return { image, text };
}

export async function tap(context: AppContext, x: number, y: number, label = 'explore tap'): Promise<void> {
    await tapCoordinate(context.driver, x, y, label, { radius: 3 });
}

export async function swipe(context: AppContext, from: { x: number; y: number }, to: { x: number; y: number }, durationMs = 450): Promise<void> {
    await swipeCoordinates(context.driver, from, to, durationMs);
}
