import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import sharp from 'sharp';

import { captionFromWords, readReelScreenshot, reelKind, reelsTabPoint } from '../src/instagram/reels-screen.js';
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

// Something in the video across the heart (frame 14 of a run, 2026-11-27: a
// panel's border) left the bubble found and the heart not: the screen read as
// a card and the Reel was skipped unjudged. Here the heart is painted over.
for (const [name, heartY, kind] of [['reel-progress-17', 884, 'reel'], ['reel-white', 884, 'reel'], ['ad-light', 1015, 'ad']] as const) {
    test(`heart unreadable, bubble sure: still a ${kind}, with no like button: ${name}`, async () => {
        const patch = await sharp({ create: { width: 64, height: 56, channels: 3, background: '#808080' } }).png().toBuffer();
        const image = await sharp(await shot(name)).composite([{ input: patch, left: 736, top: heartY - 28 }]).jpeg({ quality: 92 }).toBuffer();
        const screen = await readReelScreenshot(image, 2);
        assert.equal(screen.kind, kind);
        assert.equal(screen.like, undefined);
        assert.ok(screen.comment && screen.comment.x === 384, JSON.stringify(screen.comment));
    });
}

test('reelKind: Sponsorisée makes an ad on the Reels tab even without the rail', () => {
    assert.equal(reelKind(true, false, true), 'ad');
    assert.equal(reelKind(true, true, true), 'ad');
    assert.equal(reelKind(true, true, false), 'reel');
    assert.equal(reelKind(true, false, false), 'other');
    // A sponsored post on the home feed (no Reels tab, no rail) is not a Reel ad.
    assert.equal(reelKind(false, false, true), 'other');
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

// OCR words from a run on 2026-11-27 (screenshot px, 828 wide).
test('captionFromWords: a missed name gives no account, never caption words', () => {
    // axelramponi's name line wasn't read; "nous raconte une" is on the caption line, which starts at the left edge.
    assert.deepEqual(captionFromWords([word('Jean-Axel', 35, 1556), word('nous', 160, 1556), word('raconte', 230, 1556), word('une', 340, 1556)], 828),
        { sponsored: false });
});

test('captionFromWords: the line with Suivre is the name line, avatar noise and the verified badge aside', () => {
    assert.deepEqual(captionFromWords([
        word(',', 73, 1468), word('lecathodeservice', 138, 1473), word('®', 379, 1473), word('Suivre', 450, 1474),
        word('Moi', 35, 1558), word('qui', 89, 1558), word('pensais', 136, 1559), word('me', 242, 1563),
    ], 828), { sponsored: false, account: 'lecathodeservice' });
});

test('captionFromWords: a followed account (no Suivre) still reads, from the line not starting at the edge', () => {
    assert.deepEqual(captionFromWords([word('vincent.lapierre', 136, 1475), word('«', 35, 1560), word('Depuis', 60, 1560), word('une', 160, 1560)], 828),
        { sponsored: false, account: 'vincent.lapierre' });
});
