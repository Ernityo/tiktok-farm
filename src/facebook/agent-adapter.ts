// Facebook Reels for the agentic doomscroll (src/agent/session.ts).
// Everything is read from screenshots, like the programmatic Reels
// doomscroll: the like/comment/share column, "Afficher l'original" on
// translated captions, and the progress bar.

import type { AgentAppAdapter, AppContext } from '../agent/session.js';
import { FACEBOOK_PLUGIN_ID } from '../facebook-plugin.js';
import { swipeCoordinates, tapCoordinate } from '../tiktok/actions.js';
import { detectReelsControls, detectTranslatedCaption } from './reels-controls.js';
import { readReelProgress } from './reels-progress.js';

function layout(context: AppContext) {
    const facebook = context.coordinates.facebook;
    if (!facebook) {
        throw new Error('This phone\'s coordinate profile has no Facebook layout yet; only measured devices (iPhone XR) are supported');
    }
    return facebook;
}

export const facebookAdapter: AgentAppAdapter = {
    app: 'facebook',
    label: 'Facebook',
    pluginId: FACEBOOK_PLUGIN_ID,
    bundleId: process.env.FACEBOOK_BUNDLE_ID ?? 'com.facebook.Facebook',
    canSave: false,
    // Left of the button column, above the tab bar, sent at full resolution.
    captionCrop: { left: 0, top: 0.6, width: 0.85, height: 0.32 },
    tapRadius: 4,

    async openFeed(context) {
        const facebook = layout(context);
        // A cold launch opens the home feed; Reels is a tab away.
        await tapCoordinate(context.driver, facebook.reelsTab.x, facebook.reelsTab.y, 'Reels tab', { radius: 6 });
        await context.driver.pause(3000);
        // The first Reel can be a suggestion card: allow a few swipes to find the rail.
        for (let attempt = 0; attempt <= 3; attempt++) {
            if (await detectReelsControls(await context.screenshot(), context.scale).catch(() => undefined)) return;
            if (attempt < 3) {
                await this.fixedSwipe(context);
                await context.driver.pause(2500);
            }
        }
        throw new Error('Could not confirm the Facebook Reels screen (no like/comment/share column found)');
    },

    async inspect(context, screenshot) {
        const [controls, translated] = await Promise.all([
            detectReelsControls(screenshot, context.scale).catch(() => undefined),
            detectTranslatedCaption(screenshot, context.scale).catch(() => ({ translated: false, score: 0 })),
        ]);
        // Ads are spotted from the OCR'd "Sponsorisé" label by the session.
        // The column is missed over light video now and then, so a missing
        // column doesn't skip the Reel: the model still judges it.
        const noControls = !controls;
        if (translated.translated) return { isAd: false, noControls, autoSkip: 'foreign' };
        return { isAd: false, noControls };
    },

    async locateControls(context) {
        const controls = await detectReelsControls(await context.screenshot(), context.scale);
        return controls ? { like: { ...controls.like, liked: controls.liked } } : undefined;
    },

    async readProgress(context) {
        const progress = await readReelProgress(await context.screenshot(), context.scale);
        return progress === undefined ? {} : { progress };
    },

    async fixedSwipe(context) {
        const { x, startY, endY, durationMs } = layout(context).swipe;
        return swipeCoordinates(context.driver, { x, y: startY }, { x, y: endY }, durationMs);
    },
};
