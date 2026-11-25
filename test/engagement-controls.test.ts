import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { detectEngagementControls } from '../src/tiktok/engagement-controls.js';

// Real iPhone XR screenshots (scale 2) of the TikTok For You feed. Everything
// left of the right-hand button rail is blacked out: the detector only reads
// the rail, and this keeps the files small and free of other people's videos.
const fixture = (name: string) => readFile(new URL(`./fixtures/tiktok-feed/${name}`, import.meta.url));
const SCALE = 2;
const XR_GAP_PT = 603 - 471; // iphonexr profile: save.y - like.y
const TOLERANCE_PT = 4;

function assertNear(actual: { x: number; y: number }, expected: { x: number; y: number }, label: string): void {
    const distance = Math.hypot(actual.x - expected.x, actual.y - expected.y);
    assert.ok(distance <= TOLERANCE_PT, `${label}: expected ~(${expected.x}, ${expected.y}), got (${actual.x}, ${actual.y})`);
}

const videos = [
    { name: 'feed-normal-1.png', like: { x: 383, y: 472 }, save: { x: 383, y: 603 }, liked: false, saved: false },
    { name: 'feed-normal-2.png', like: { x: 383, y: 473 }, save: { x: 383, y: 602 }, liked: false, saved: false },
    { name: 'feed-normal-3.png', like: { x: 383, y: 475 }, save: { x: 383, y: 603 }, liked: false, saved: false },
    // No search bar under the caption: TikTok drops the whole rail ~40 pt. At
    // the fixed profile coordinates, "like" would hit the Follow "+".
    { name: 'feed-shifted-down.png', like: { x: 383, y: 510 }, save: { x: 383, y: 639 }, liked: false, saved: false },
    { name: 'feed-shifted-down-striped-background.png', like: { x: 383, y: 511 }, save: { x: 383, y: 639 }, liked: false, saved: false },
    { name: 'feed-ad-shifted-down.png', like: { x: 383, y: 510 }, save: { x: 383, y: 639 }, liked: false, saved: false },
    { name: 'feed-liked-and-saved.png', like: { x: 383, y: 473 }, save: { x: 383, y: 602 }, liked: true, saved: true },
];

for (const video of videos) {
    test(`detects like/save on ${video.name}`, async () => {
        const detected = await detectEngagementControls(await fixture(video.name), SCALE, { expectedGapPt: XR_GAP_PT });
        assert.ok(detected, 'expected the button rail to be detected');
        assertNear(detected.like, video.like, 'like');
        assertNear(detected.save, video.save, 'save');
        assert.equal(detected.liked, video.liked, 'liked state');
        assert.equal(detected.saved, video.saved, 'saved state');
    });
}

// Feed items without a like/save rail: doomscroll must not tap anything.
const nonVideos = ['live-preview-1.png', 'live-preview-2.png', 'follow-back-card.png', 'tiktok-shop-promo.png'];

for (const name of nonVideos) {
    test(`detects nothing on ${name}`, async () => {
        const detected = await detectEngagementControls(await fixture(name), SCALE, { expectedGapPt: XR_GAP_PT });
        assert.equal(detected, undefined);
    });
}
