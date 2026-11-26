import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import sharp from 'sharp';

import { readTikTokProgress } from '../src/tiktok/video-progress.js';

// Fixtures are the bottom strip (rows 1560–1640) of real 828×1792 iPhone XR
// screenshots; they're put back in place on a black screen of that size.
const SCALE = 2;
const STRIP_TOP = 1560;

async function screen(name: string, edit?: (raw: Buffer, width: number) => void): Promise<Buffer> {
    const strip = await readFile(new URL(`./fixtures/tiktok-progress/${name}.png`, import.meta.url));
    let input = strip;
    if (edit) {
        const { data, info } = await sharp(strip).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        edit(data, info.width);
        input = await sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer();
    }
    return sharp({ create: { width: 828, height: 1792, channels: 3, background: '#000' } })
        .composite([{ input, top: STRIP_TOP, left: 0 }]).png().toBuffer();
}

for (const [name, expected] of [['bar-playlist-start', 0.03], ['bar-playlist-later', 0.05], ['bar-search', 0.1], ['bar-bright-video', 0.09]] as const) {
    test(`reads the progress bar on ${name}`, async () => {
        const progress = await readTikTokProgress(await screen(name), SCALE);
        assert.ok(progress !== undefined, 'expected the bar to be found');
        assert.ok(Math.abs(progress - expected) < 0.02, `progress ${progress}`);
    });
}

for (const name of ['no-bar-ai-label', 'no-bar-ad', 'no-bar-shop']) {
    test(`finds no progress bar on ${name}`, async () => {
        assert.equal(await readTikTokProgress(await screen(name), SCALE), undefined);
    });
}

test('reads a half-filled bar', async () => {
    // Paint the fill over the inner bar rows (1621–1622) up to the middle of
    // the bar (x 26..413) with the brightness measured on real fills.
    const progress = await readTikTokProgress(await screen('bar-search', (raw, width) => {
        for (const y of [1620, 1621, 1622, 1623]) {
            for (let x = 26; x <= 413; x++) raw.fill(150, ((y - STRIP_TOP) * width + x) * 3, ((y - STRIP_TOP) * width + x) * 3 + 3);
        }
    }), SCALE);
    assert.ok(progress !== undefined);
    assert.ok(Math.abs(progress - 0.5) < 0.03, `progress ${progress}`);
});

test('a screen without the tab bar has no progress', async () => {
    const blank = await sharp({ create: { width: 828, height: 1792, channels: 3, background: '#808080' } }).png().toBuffer();
    assert.equal(await readTikTokProgress(blank, SCALE), undefined);
});
