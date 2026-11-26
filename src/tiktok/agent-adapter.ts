// TikTok for the agentic doomscroll (src/agent/session.ts). The app opens
// straight on the For You feed; the heart/bookmark rail and the progress bar
// are read from screenshots, and ads get a second, stricter OCR pass.

import type { AgentAppAdapter, AppContext } from '../agent/session.js';
import { swipeCoordinates } from './actions.js';
import { detectAdStrict } from './ad-detection.js';
import { detectEngagementControls } from './engagement-controls.js';
import { normalizeHandle } from './niche.js';
import { registeredAccounts, TIKTOK_PLUGIN_ID } from './runtime-settings.js';
import { readTikTokProgress } from './video-progress.js';

const layout = (context: AppContext) => context.coordinates.tiktok;

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
