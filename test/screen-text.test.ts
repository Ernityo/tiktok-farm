import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { groupPhrases, isNoise, mergePasses, readScreenText } from '../src/agent/screen-text.js';
import type { OcrWord } from '../src/tiktok/ocr.js';

const word = (text: string, x: number, y: number, confidence = 90, height = 20): OcrWord => ({ text, x, y, width: text.length * 12, height, confidence });

test('groupPhrases joins close words on a line and splits at wide gaps (points at scale 2)', () => {
    const phrases = groupPhrases([word('Tes', 100, 500), word('commandes', 145, 502), word('Profil', 700, 1690), word('X', 760, 500)], 2);
    assert.deepEqual(phrases.map((p) => p.text), ['Tes commandes', 'X', 'Profil']);
    assert.deepEqual(phrases[0], { text: 'Tes commandes', x: 88, y: 256, width: 77, height: 11 });
});

test('isNoise drops glyph scraps but keeps short words read well', () => {
    assert.equal(isNoise(word('-', 0, 0, 95)), true);
    assert.equal(isNoise(word('T', 0, 0, 40)), true);
    assert.equal(isNoise(word('o,', 0, 0, 60)), true);
    assert.equal(isNoise(word('16', 0, 0, 96)), false);
    assert.equal(isNoise(word('Followers', 0, 0, 50)), false);
});

test('mergePasses keeps the first read of a spot', () => {
    const merged = mergePasses([[word('Suivis', 30, 370)], [word('Suivls', 31, 371), word('Accueil', 60, 1690)]]);
    assert.deepEqual(merged.map((w) => w.text), ['Suivis', 'Accueil']);
});

test('readScreenText reads our own Profile tab', async () => {
    const phrases = await readScreenText(await readFile(new URL('./fixtures/tiktok-account/own-profile.jpg', import.meta.url)), 2);
    const texts = phrases.map((p) => p.text);
    for (const expected of ['@metafruit67', 'Followers', 'Accueil', 'Profil']) assert.ok(texts.includes(expected), `${expected} in ${JSON.stringify(texts)}`);
    const profil = phrases.find((p) => p.text === 'Profil')!;
    assert.ok(Math.abs(profil.x - 373) <= 6 && Math.abs(profil.y - 851) <= 6);
});
