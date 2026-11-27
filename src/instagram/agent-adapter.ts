// Instagram Reels for the agentic doomscroll (src/agent/session.ts).
// Read off screenshots (reels-screen.ts), like the programmatic Reels
// doomscroll: the Reels tab, J'aime and whether it is pressed, "Sponsorisée",
// the video progress, and which Reel is on screen. Comments go through the comment
// sheet (src/instagram/comment.ts).

import type { AgentAppAdapter, AppContext } from '../agent/session.js';
import { leaveComment } from '../agent/comment-flow.js';
import { INSTAGRAM_PLUGIN_ID } from '../instagram-plugin.js';
import { INSTAGRAM_COMMENT_SHEET } from './comment.js';
import { swipeCoordinates, tapCoordinate } from '../tiktok/actions.js';
import { readReelScreenshot, reelsTabPoint, type ReelScreen } from './reels-screen.js';

async function readScreen(context: AppContext, screenshot?: Buffer): Promise<ReelScreen> {
    return readReelScreenshot(screenshot ?? await context.screenshot(), context.scale);
}

export const instagramAdapter: AgentAppAdapter = {
    app: 'instagram',
    label: 'Instagram',
    pluginId: INSTAGRAM_PLUGIN_ID,
    bundleId: process.env.INSTAGRAM_BUNDLE_ID ?? 'com.burbn.instagram',
    canSave: false,
    // Left of the button column, above the tab bar, sent at full resolution.
    captionCrop: { left: 0, top: 0.6, width: 0.85, height: 0.32 },
    tapRadius: 4,
    // Flicks of 74 and 85 pt left the feed on the same Reel (2026-11-27); 122+ pt always moved it.
    minSwipeTravel: 110,

    async openFeed(context) {
        const tab = reelsTabPoint(context.window);
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

    async inspect(context, screenshot) {
        const screen = await readScreen(context, screenshot).catch(() => undefined);
        if (!screen || !screen.onReels || screen.kind === 'other') return { isAd: false, autoSkip: 'card' };
        return { isAd: screen.kind === 'ad', ...(screen.reelId ? { reelId: screen.reelId } : {}) };
    },

    async locateControls(context, reelId) {
        const screen = await readScreen(context);
        if (screen.kind !== 'reel' || !screen.like) return undefined;
        // Instagram can move to the next Reel on its own; never like that one.
        if (reelId && screen.reelId !== reelId) return undefined;
        return { like: screen.like };
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
    async comment(context, text) {
        return leaveComment(context, INSTAGRAM_COMMENT_SHEET, text);
    },

    async fixedSwipe(context) {
        const { width, height } = context.window;
        const x = Math.round(width * 0.5);
        return swipeCoordinates(context.driver, { x, y: Math.round(height * 0.62) }, { x, y: Math.round(height * 0.21) }, 380);
    },
};
