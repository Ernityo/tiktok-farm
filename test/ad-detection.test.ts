import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { detectAd, isAdLabel } from '../src/tiktok/ad-detection.js';

// Real iPhone XR screenshots of the TikTok For You feed. Only the caption
// area that detectAd reads is kept; the rest is blacked out.
const fixture = (name: string) => readFile(new URL(`./fixtures/tiktok-ads/${name}`, import.meta.url));

test('isAdLabel matches ad labels with or without accents', () => {
    for (const text of ['Publicité', 'Publicite', 'Sponsored', 'Sponsorisé', 'Promoted', 'Anzeige', 'Pubblicità']) {
        assert.ok(isAdLabel(text), text);
    }
    for (const text of ['Public', 'Pour', 'Regarder', 'Réserver', 'publication', '#pourtoi']) {
        assert.ok(!isAdLabel(text), text);
    }
});

const ads = [
    'ad-booking.png',
    'ad-carrefour.png',
    'ad-paypal-with-form-card.png',
    'ad-tiktok-sticker.png',
    'ad-tiktok-with-form-card.png',
    'ad-label-over-silver-chain.png',
];

for (const name of ads) {
    test(`detects the ad label on ${name}`, async () => {
        const result = await detectAd(await fixture(name));
        assert.equal(result.isAd, true);
    });
}

const notAds = [
    'post-normal-1.png',
    'post-normal-2.png',
    'post-normal-3.png',
    'post-capcut-caption.png',
    'post-striped-background.png',
    'live-preview.png',
    'follow-back-card.png',
    'tiktok-shop-promo.png',
];

for (const name of notAds) {
    test(`does not flag ${name} as an ad`, async () => {
        const result = await detectAd(await fixture(name));
        assert.equal(result.isAd, false, `matched "${result.label}"`);
    });
}
