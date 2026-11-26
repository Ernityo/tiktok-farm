// Instagram Reels for the agentic doomscroll (src/agent/reels-session.ts).
// Read from the accessibility tree, like the programmatic Reels doomscroll:
// the Reels tab, J'aime and whether it is pressed, "Sponsorisée", the video
// progress, and which Reel is on screen.

import type { ReelsAppAdapter, ReelsContext } from '../agent/reels-session.js';
import { INSTAGRAM_PLUGIN_ID } from '../instagram-plugin.js';
import { swipeCoordinates, tapCoordinate } from '../tiktok/actions.js';
import { findReelsTab, parseSource, readReelScreen, type ReelScreen, type SourceNode } from './reels-screen.js';

async function readTree(context: ReelsContext): Promise<SourceNode> {
    return parseSource(await context.driver.execute('mobile: source', { format: 'json' }));
}

async function readScreen(context: ReelsContext): Promise<ReelScreen> {
    return readReelScreen(await readTree(context));
}

export const instagramAdapter: ReelsAppAdapter = {
    app: 'instagram',
    label: 'Instagram',
    pluginId: INSTAGRAM_PLUGIN_ID,
    bundleId: process.env.INSTAGRAM_BUNDLE_ID ?? 'com.burbn.instagram',

    async openReels(context) {
        const tab = findReelsTab(await readTree(context));
        if (!tab) throw new Error('Could not find the Instagram Reels tab (is Instagram logged in?)');
        await tapCoordinate(context.driver, tab.x, tab.y, 'Reels tab', { radius: 6 });
        await context.driver.pause(3000);
        // The first screen can be a card: allow a few swipes to find a Reel.
        for (let attempt = 0; attempt <= 3; attempt++) {
            const screen = await readScreen(context).catch(() => undefined);
            if (screen?.onReels && screen.kind !== 'other') return;
            if (!screen?.onReels) break;
            if (attempt < 3) {
                await this.fixedSwipe(context);
                await context.driver.pause(2500);
            }
        }
        throw new Error('Could not confirm the Instagram Reels screen (no Reel with a J\'aime button found)');
    },

    async inspect(context) {
        const screen = await readScreen(context).catch(() => undefined);
        if (!screen || !screen.onReels || screen.kind === 'other') return { isAd: false, autoSkip: 'card' };
        return { isAd: screen.kind === 'ad', ...(screen.reelId ? { reelId: screen.reelId } : {}) };
    },

    async locateLike(context, reelId) {
        const screen = await readScreen(context);
        if (screen.kind !== 'reel' || !screen.like) return undefined;
        // Instagram can move to the next Reel on its own; never like that one.
        if (reelId && screen.reelId !== reelId) return undefined;
        return screen.like;
    },

    async readProgress(context) {
        const screen = await readScreen(context);
        return {
            ...(screen.progress !== undefined ? { progress: screen.progress } : {}),
            ...(screen.reelId ? { reelId: screen.reelId } : {}),
        };
    },

    async currentReelId(context) {
        return (await readScreen(context)).reelId;
    },

    // Upward swipe on the video: above the caption and the ad call-to-action strip.
    async fixedSwipe(context) {
        const { width, height } = context.window;
        const x = Math.round(width * 0.5);
        return swipeCoordinates(context.driver, { x, y: Math.round(height * 0.62) }, { x, y: Math.round(height * 0.21) }, 380);
    },
};
