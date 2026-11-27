import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { captionFromWords, readReelScreenshot, reelsTabPoint } from '../src/instagram/reels-screen.js';
import type { OcrWord } from '../src/tiktok/ocr.js';

// Screenshots of Instagram Reels on an iPhone XR (2x), French UI, 2026-11-28.
// reel-liked-synthetic.jpg is reel-progress-17.jpg with its heart filled
// Instagram red (#FF3040) by hand: no real liked Reel was captured.
const shot = (name: string) => readFile(new URL(`./fixtures/instagram-reels/${name}.jpg`, import.meta.url));

// On a Reel the heart sits at (384, 442) pt; on these ads at (384, 508).
for (const [name, progress, reelId] of [
    ['reel-progress-17', 0.175, 'Reel de gino_corleone_'],
    ['reel-progress-25', 0.248, 'Reel de gino_corleone_'],
    ['reel-bright', 0.957, 'Reel de laviedevirginie_'],
    ['reel-busy', 0.169, 'Reel de laurence.trochu'],
    ['reel-white', 0.528, 'Reel de laurence.trochu'],
] as const) {
    test(`reads a normal Reel: ${name}`, async () => {
        const screen = await readReelScreenshot(await shot(name), 2);
        assert.equal(screen.onReels, true);
        assert.equal(screen.kind, 'reel');
        assert.deepEqual(screen.like, { x: 384, y: 442, liked: false });
        assert.ok(screen.progress !== undefined && Math.abs(screen.progress - progress) < 0.01, `progress ${screen.progress}`);
        assert.equal(screen.reelId, reelId);
    });
}

test('an already-liked Reel (red heart) is reported as liked so the like is not undone', async () => {
    const screen = await readReelScreenshot(await shot('reel-liked-synthetic'), 2);
    assert.equal(screen.kind, 'reel');
    assert.equal(screen.like?.liked, true);
    assert.ok(Math.abs(screen.like!.y - 442) <= 3);
});

for (const [name, reelId] of [['ad-photo', 'Reel de Evelyn Foster'], ['ad-light', 'Reel de textboba']] as const) {
    test(`a sponsored post is an ad: ${name}`, async () => {
        const screen = await readReelScreenshot(await shot(name), 2);
        assert.equal(screen.onReels, true);
        assert.equal(screen.kind, 'ad');
        assert.equal(screen.reelId, reelId);
        // A photo's bar never fills: no progress to follow.
        assert.equal(screen.progress, undefined);
    });
}

for (const name of ['home-feed', 'ad-browser', 'comment-sheet']) {
    test(`not a Reel on screen: ${name}`, async () => {
        const screen = await readReelScreenshot(await shot(name), 2);
        assert.equal(screen.onReels, false);
        assert.equal(screen.kind, 'other');
        assert.equal(screen.like, undefined);
        assert.equal(screen.reelId, undefined);
    });
}

test('the Reels tab is the second of five slots above the home indicator', () => {
    assert.deepEqual(reelsTabPoint({ width: 414, height: 896 }), { x: 124, y: 838 });
});

const word = (text: string, x: number, y: number): OcrWord => ({ text, x, y, width: text.length * 16, height: 30, confidence: 90 });

test('captionFromWords: the name right of the avatar up to Suivre, and Sponsorisée', () => {
    assert.deepEqual(captionFromWords([word('.', 59, 1496), word('gino_corleone_', 122, 1479), word('Suivre', 370, 1479), word('Alors', 34, 1555)], 828),
        { sponsored: false, account: 'gino_corleone_' });
    assert.deepEqual(captionFromWords([word('Evelyn', 123, 1480), word('Foster', 218, 1481), word('Lisez', 35, 1555), word('Sponsorisée', 651, 1557)], 828),
        { sponsored: true, account: 'Evelyn Foster' });
    assert.deepEqual(captionFromWords([word('Apocalypse', 34, 1555)], 828), { sponsored: false });
});
