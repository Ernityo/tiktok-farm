import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { detectReelsControls } from '../src/facebook/reels-controls.js';

// Real iPhone XR screenshots (scale 2) of Facebook Reels, French UI.
const fixture = (name: string) => readFile(new URL(`./fixtures/facebook-reels/${name}.png`, import.meta.url));
const SCALE = 2;
// Measured J'aime centre on the XR: 385.5 pt across; 500 pt down, or 482 pt
// when the like count wraps onto two lines.
const LIKE_X = 385;

function near(actual: number, expected: number, tolerance: number, label: string): void {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ±${tolerance}, got ${actual}`);
}

for (const [name, expectedY] of [
    ['reel-dark', 500],
    ['reel-light-background', 500],
    ['reel-fake-app-ui', 500],
    ['reel-interest-popup', 500],
    ['reel-count-two-lines', 482],
] as const) {
    test(`finds the not-yet-liked J'aime button: ${name}`, async () => {
        const controls = await detectReelsControls(await fixture(name), SCALE);
        assert.ok(controls, 'expected the rail to be detected');
        assert.equal(controls.liked, false);
        near(controls.like.x, LIKE_X, 4, 'like.x');
        near(controls.like.y, expectedY, 5, 'like.y');
        near(controls.comment.y, 572, 5, 'comment.y');
    });
}

test('recognises an already-liked Reel (blue disc) so the like is not undone', async () => {
    const controls = await detectReelsControls(await fixture('reel-liked'), SCALE);
    assert.ok(controls);
    assert.equal(controls.liked, true);
    near(controls.like.x, LIKE_X, 4, 'like.x');
    near(controls.like.y, 482, 5, 'like.y');
});

test('a suggestion card has no rail, so nothing is detected', async () => {
    assert.equal(await detectReelsControls(await fixture('suggestion-card'), SCALE), undefined);
});

test('a white background behind the rail is skipped rather than guessed', async () => {
    assert.equal(await detectReelsControls(await fixture('reel-white-behind-rail'), SCALE), undefined);
});
