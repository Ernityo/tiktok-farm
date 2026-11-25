import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { findReelsTab, parseSource, readReelScreen, type SourceNode } from '../src/instagram/reels-screen.js';

// Real accessibility trees (WDA JSON page source) from Instagram Reels on an
// iPhone XR, French UI. Trimmed of redundant keys (frame, rawIdentifier, …).
const fixture = async (name: string) => parseSource(await readFile(new URL(`./fixtures/instagram-reels/${name}.json`, import.meta.url), 'utf8'));

// J'aime is 45×44 pt at x=361 in the right-hand column; its height depends on
// the caption length.
for (const [name, likeY, progress, reelId] of [
    ['reel', 417, 0.11, 'Reel de antony_nonis.'],
    ['reel-short-caption', 369, 0.05, 'Reel de histoire_fruit_ia_fr.'],
    ['reel-no-progress', 417, undefined, 'Reel de andrealbriziom.'],
] as const) {
    test(`reads a normal Reel: ${name}`, async () => {
        const screen = readReelScreen(await fixture(name));
        assert.equal(screen.onReels, true);
        assert.equal(screen.kind, 'reel');
        assert.deepEqual(screen.like, { x: 384, y: likeY, liked: false });
        assert.equal(screen.progress, progress);
        assert.equal(screen.reelId, reelId);
    });
}

test('an already-liked Reel ("J’aime déjà") is reported as liked so the like is not undone', async () => {
    const screen = readReelScreen(await fixture('reel-liked'));
    assert.equal(screen.kind, 'reel');
    assert.equal(screen.like?.liked, true);
    assert.equal(screen.reelId, 'Reel de boss_ramses.');
});

test('a sponsored Reel is an ad', async () => {
    const screen = readReelScreen(await fixture('ad-reel'));
    assert.equal(screen.kind, 'ad');
    assert.equal(screen.reelId, 'Reel sponsorisé de busjam.s.');
    assert.equal(screen.progress, 0.1);
});

test('a sponsored photo is an ad', async () => {
    const screen = readReelScreen(await fixture('ad-photo'));
    assert.equal(screen.kind, 'ad');
    assert.equal(screen.progress, undefined);
});

test('a Threads card inside Reels has only inline like buttons, so it is not a Reel', async () => {
    const screen = readReelScreen(await fixture('threads-card'));
    assert.equal(screen.onReels, true);
    assert.equal(screen.kind, 'other');
    assert.equal(screen.like, undefined);
});

test('finds the Reels tab', async () => {
    assert.deepEqual(findReelsTab(await fixture('reel')), { x: 125, y: 838 });
});

test('another selected tab means we are not on Reels', () => {
    const tree: SourceNode = {
        type: 'Application', isVisible: '1', rect: { x: 0, y: 0, width: 414, height: 896 },
        children: [
            { type: 'Button', name: 'mainfeed-tab', value: '1', isVisible: '1', rect: { x: 2, y: 813, width: 82, height: 49 } },
            { type: 'Button', name: 'reels-tab', value: null, isVisible: '1', rect: { x: 84, y: 813, width: 82, height: 49 } },
        ],
    };
    const screen = readReelScreen(tree);
    assert.equal(screen.onReels, false);
    assert.equal(screen.kind, 'other');
});

test('a like button scrolled off screen (next Reel) is ignored', () => {
    const tree: SourceNode = {
        type: 'Application', isVisible: '1', rect: { x: 0, y: 0, width: 414, height: 896 },
        children: [
            { type: 'Button', name: 'like-button', label: 'J’aime', isVisible: '1', rect: { x: 361, y: 1291, width: 45, height: 44 } },
        ],
    };
    assert.equal(readReelScreen(tree).kind, 'other');
});

test('parseSource accepts the JSON string form and rejects non-objects', () => {
    assert.equal(parseSource('{"type":"Application"}').type, 'Application');
    assert.throws(() => parseSource('[]'));
});
