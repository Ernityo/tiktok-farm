import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import sharp from 'sharp';

import { detectEngagementControls } from '../src/tiktok/engagement-controls.js';
import { detectFollowPlus } from '../src/tiktok/follow-button.js';

const fixture = (name: string) => readFile(new URL(`./fixtures/tiktok-feed/${name}`, import.meta.url));

for (const name of ['feed-normal-1.png', 'feed-normal-2.png', 'feed-normal-3.png', 'feed-liked-and-saved.png', 'feed-shifted-down.png', 'feed-shifted-down-striped-background.png']) {
    test(`the Follow + is found above the heart: ${name}`, async () => {
        const screenshot = await fixture(name);
        const controls = await detectEngagementControls(screenshot, 2, { expectedGapPt: 132 });
        assert.ok(controls);
        const plus = await detectFollowPlus(screenshot, 2, controls.like);
        assert.ok(plus, 'no + found');
        assert.ok(Math.abs(plus.x - controls.like.x) <= 2);
        // ~50 pt above the heart, wherever the rail sits; a liked (red) heart isn't mistaken for it.
        assert.ok(controls.like.y - plus.y >= 45 && controls.like.y - plus.y <= 55, `${controls.like.y - plus.y} pt above`);
    });
}

test('no Follow + once it is gone (already following)', async () => {
    const screenshot = await fixture('feed-normal-2.png');
    const controls = (await detectEngagementControls(screenshot, 2, { expectedGapPt: 132 }))!;
    const covered = await sharp(screenshot).composite([{
        input: { create: { width: 60, height: 60, channels: 3, background: '#203040' } },
        left: controls.like.x * 2 - 30, top: controls.like.y * 2 - 130,
    }]).png().toBuffer();
    assert.equal(await detectFollowPlus(covered, 2, controls.like), undefined);
});
