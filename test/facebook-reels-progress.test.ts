import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import sharp from 'sharp';

import { ReelWatchTracker, readReelProgress } from '../src/facebook/reels-progress.js';

// Real iPhone XR screenshots (scale 2) of Facebook Reels.
const fixture = (name: string) => readFile(new URL(`./fixtures/facebook-reels/${name}.png`, import.meta.url));
const SCALE = 2;

/** Paints the bar's white fill up to `endPx` (pixels across) on a screenshot. */
async function withFill(name: string, endPx: number): Promise<Buffer> {
    const { data, info } = await sharp(await fixture(name)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let y = 1632; y <= 1635; y++) {
        for (let x = 24; x <= endPx; x++) {
            const o = (y * info.width + x) * info.channels;
            data[o] = data[o + 1] = data[o + 2] = 255;
        }
    }
    return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
}

test('reads a bar that has just started', async () => {
    const progress = await readReelProgress(await fixture('progress-start'), SCALE);
    assert.ok(progress !== undefined, 'expected the bar to be found');
    assert.ok(progress < 0.03, `progress ${progress}`);
});

test('reads the bar on a video with chapters', async () => {
    const progress = await readReelProgress(await fixture('progress-chapters'), SCALE);
    assert.ok(progress !== undefined, 'expected the bar to be found');
    assert.ok(progress < 0.03, `progress ${progress}`);
});

test('reads a half-played bar', async () => {
    // Track runs from 24 to ~803 px; filling to 413 px is half.
    const progress = await readReelProgress(await withFill('progress-start', 413), SCALE);
    assert.ok(progress !== undefined);
    assert.ok(Math.abs(progress - 0.5) < 0.03, `progress ${progress}`);
});

test('reads a nearly finished bar on another video', async () => {
    const progress = await readReelProgress(await withFill('progress-chapters', 780), SCALE);
    assert.ok(progress !== undefined);
    assert.ok(progress > 0.95, `progress ${progress}`);
});

for (const name of ['progress-no-bar', 'reel-dark', 'reel-light-background', 'reel-liked', 'reel-white-behind-rail', 'suggestion-card']) {
    test(`no progress bar: ${name}`, async () => {
        assert.equal(await readReelProgress(await fixture(name), SCALE), undefined);
    });
}

test('a watch completes when the bar loops back to the start, with the video length estimated', () => {
    const tracker = new ReelWatchTracker();
    assert.deepEqual(tracker.add({ atMs: 0, progress: 0.1 }), { kind: 'watching' });
    assert.deepEqual(tracker.add({ atMs: 5_000, progress: 0.35 }), { kind: 'watching' });
    assert.deepEqual(tracker.add({ atMs: 15_000, progress: 0.85 }), { kind: 'watching' });
    // 0.75 of the video in 15 s → a 20 s video.
    assert.deepEqual(tracker.add({ atMs: 19_000, progress: 0.05 }), { kind: 'completed', durationMs: 20_000 });
});

test('small backwards jitter is not a loop', () => {
    const tracker = new ReelWatchTracker();
    tracker.add({ atMs: 0, progress: 0.5 });
    assert.deepEqual(tracker.add({ atMs: 1_000, progress: 0.48 }), { kind: 'watching' });
});

test('a loop caught after too little progress has no duration estimate', () => {
    const tracker = new ReelWatchTracker();
    tracker.add({ atMs: 0, progress: 0.95 });
    assert.deepEqual(tracker.add({ atMs: 1_500, progress: 0.02 }), { kind: 'completed', durationMs: undefined });
});
