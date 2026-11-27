import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { readOwnProfile, readsAsHandle, sameHandle, switcherOpen, switcherRow } from '../src/tiktok/account.js';
import type { OcrWord } from '../src/tiktok/ocr.js';

const shot = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

const word = (text: string, x: number, y: number): OcrWord => ({ text, x, y, width: text.length * 18, height: 34, confidence: 90 });

// The switcher sheet, as OCR words in device pixels (scale 2, screen 1792 px tall).
const SHEET: OcrWord[] = [
    word('francois2k', 40, 220), // the profile's own name, top of the screen
    word('Changer', 300, 1155), word('de', 440, 1155), word('compte', 490, 1155),
    word('metafruit67', 206, 1283),
    word('francois2k', 206, 1435),
    word('Ajouter', 206, 1587), word('un', 340, 1587), word('compte', 390, 1587),
];

// Our own Profile tab (French app, iPhone XR at 2x, 2026-11-28): the ▼ sits
// right of "metafruit67" at about (199, 117) points.
test('readOwnProfile reads the handle and finds the switcher arrow', async () => {
    const profile = await readOwnProfile(await shot('tiktok-account/own-profile.jpg'), 2);
    assert.ok(profile);
    assert.equal(profile.handle, '@metafruit67');
    assert.ok(profile.switcher);
    assert.ok(Math.abs(profile.switcher.x - 199) <= 4 && Math.abs(profile.switcher.y - 117) <= 4, JSON.stringify(profile.switcher));
});

test('readOwnProfile is undefined off the Profile tab', async () => {
    assert.equal(await readOwnProfile(await shot('tiktok-feed/feed-normal-1.png'), 2), undefined);
});

test('sameHandle ignores the @ and case', () => {
    assert.equal(sameHandle('@MetaFruit67', 'metafruit67'), true);
    assert.equal(sameHandle('@francois2k', '@metafruit67'), false);
    assert.equal(sameHandle('@', ''), false);
});

test('readsAsHandle allows one OCR slip on long handles only', () => {
    assert.equal(readsAsHandle('@metafruité67', '@metafruit67'), true);
    assert.equal(readsAsHandle('@metafruit67', 'metafruit67'), true);
    assert.equal(readsAsHandle('@francois2k', '@metafruit67'), false);
    assert.equal(readsAsHandle('@abcd', '@abce'), false);
});

test('switcherOpen spots the sheet title in the lower half only', () => {
    assert.equal(switcherOpen(SHEET, 1792), true);
    assert.equal(switcherOpen([word('Changer', 300, 200), word('de', 440, 200), word('compte', 490, 200)], 1792), false);
    assert.equal(switcherOpen([word('Switch', 300, 1155), word('account', 440, 1155)], 1792), true);
});

test('switcherRow finds the target row, not the profile name at the top', () => {
    assert.equal(switcherRow(SHEET, '@metafruit67', 1792)?.y, 1283);
    assert.equal(switcherRow(SHEET, 'francois2k', 1792)?.y, 1435);
    assert.equal(switcherRow(SHEET, '@someoneelse', 1792), undefined);
});
