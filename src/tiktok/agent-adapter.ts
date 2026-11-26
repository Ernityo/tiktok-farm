// TikTok for the agentic doomscroll (src/agent/session.ts). The app opens
// straight on the For You feed; the heart/bookmark rail and the progress bar
// are read from screenshots, and ads get a second, stricter OCR pass.

import { AppStuckError } from '../agent/comment.js';
import type { AgentAppAdapter, AppContext } from '../agent/session.js';
import { swipeCoordinates, tapCoordinate } from './actions.js';
import { ensureTikTokAccount } from './account.js';
import { detectAdStrict } from './ad-detection.js';
import { detectEngagementControls } from './engagement-controls.js';
import { followFromProfile } from './creator-profile.js';
import { detectFollowPlus } from './follow-button.js';
import { normalizeHandle } from './niche.js';
import { registeredAccounts, TIKTOK_PLUGIN_ID } from './runtime-settings.js';
import { readTikTokProgress } from './video-progress.js';

const layout = (context: AppContext) => context.coordinates.tiktok;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function railNow(context: AppContext) {
    const screenshot = await context.screenshot();
    const controls = await detectEngagementControls(screenshot, context.scale, {
        expectedGapPt: layout(context).save.y - layout(context).like.y,
    });
    return { screenshot, controls };
}

export const tiktokAdapter: AgentAppAdapter = {
    app: 'tiktok',
    label: 'TikTok',
    pluginId: TIKTOK_PLUGIN_ID,
    bundleId: process.env.TIKTOK_BUNDLE_ID ?? 'com.zhiliaoapp.musically',
    canSave: true,
    // Left of the button rail, above the tab bar: small grey text such as the
    // translation link ("Voir l'original") is unreadable in the small screenshot.
    captionCrop: { left: 0, top: 0.62, width: 0.85, height: 0.3 },

    checkAccount(device, account) {
        if (!registeredAccounts(device).map(normalizeHandle).includes(account)) {
            throw new Error(`${account} is not one of this device's TikTok accounts (dashboard → Accounts)`);
        }
    },

    // Profile tab → read the handle → switch if needed → back to For You.
    async ensureAccount(context, account) {
        return ensureTikTokAccount(context, account);
    },

    // The red + under the creator's avatar, above the heart; or the creator's
    // profile (src/tiktok/creator-profile.ts): Suivre, one or two of their videos, back.
    followModes: ['plus', 'profile'],
    async follow(context, how) {
        if (how === 'profile') {
            return followFromProfile(context, {
                railVisible: async () => (await railNow(context)).controls !== undefined,
                // Quicker and longer than the feed's fixed swipe: a 450 ms one didn't move this player.
                swipeUp: async () => {
                    const x = Math.round(context.window.width / 2);
                    await swipeCoordinates(context.driver, { x, y: Math.round(context.window.height * 0.78) }, { x, y: Math.round(context.window.height * 0.22) }, 300);
                },
            });
        }
        const started = Date.now();
        const before = await railNow(context);
        if (!before.controls) throw new Error('the right rail was not found');
        const plus = await detectFollowPlus(before.screenshot, context.scale, before.controls.like);
        if (!plus) throw new Error('no Follow + on the avatar (already following?)');
        await tapCoordinate(context.driver, plus.x, plus.y, 'Follow +', { radius: 3 });
        // The + turns into a tick, then disappears.
        await sleep(1200 + Math.random() * 800);
        let after = await railNow(context);
        if (!after.controls) {
            // A tap on the avatar instead opens the profile; or the rail just flickered.
            await sleep(1000);
            after = await railNow(context);
            if (!after.controls) throw new AppStuckError('Left the feed after tapping the Follow + (profile opened?)');
        }
        const still = await detectFollowPlus(after.screenshot, context.scale, after.controls.like);
        return { verified: !still, durationMs: Date.now() - started };
    },

    async strictAd(screenshot) {
        return (await detectAdStrict(screenshot)).isAd;
    },

    async locateControls(context) {
        const tiktok = layout(context);
        const controls = await detectEngagementControls(await context.screenshot(), context.scale, {
            expectedGapPt: tiktok.save.y - tiktok.like.y,
        });
        if (!controls) return undefined;
        return {
            like: { ...controls.like, liked: controls.liked },
            save: { ...controls.save, saved: controls.saved },
        };
    },

    // The bar loops, so the end shows as the fill jumping back to the start.
    async readProgress(context) {
        const progress = await readTikTokProgress(await context.screenshot(), context.scale);
        return progress === undefined ? {} : { progress };
    },

    async fixedSwipe(context) {
        const { x, startY, endY, durationMs } = layout(context).swipe;
        return swipeCoordinates(context.driver, { x, y: startY }, { x, y: endY }, durationMs);
    },

    // Ads put forms and CTA buttons where the normal swipe starts, so start
    // higher, at the same finger speed.
    async adSwipe(context) {
        const { x, startY, adStartY, endY, durationMs } = layout(context).swipe;
        const duration = Math.round(durationMs * (adStartY - endY) / (startY - endY));
        return swipeCoordinates(context.driver, { x, y: adStartY }, { x, y: endY }, duration, { startRadius: { x: 18, y: 6 } });
    },
};
