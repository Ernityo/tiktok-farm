import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import sharp from 'sharp';

import {
    KeyboardLayoutMismatch, keyboardReferences, matchKeyboard, readKeyboardScreenshot, ScreenKeyboard, type KeyboardReference,
} from '../src/devices/screen-keyboard.js';
import type { PointerAction } from '../src/devices/humanize.js';
import { typeOnKeyboard } from '../src/devices/typing.js';

// Keyboards of the Instagram (dark, with @ and #) and Facebook (light,
// default) comment boxes, iPhone XR, French AZERTY, 2026-11-28. The
// references in src/devices/keyboards/ were made from these screenshots.
const shot = (name: string) => readFile(new URL(`./fixtures/${name}.jpg`, import.meta.url));
const DARK = 'iphone828-fr-azerty-dark-at-hash';
const LIGHT = 'iphone828-fr-azerty-light';

for (const [file, set, layer] of [
    ['keyboard/instagram-comment-lower', DARK, 'lower'],
    ['keyboard/instagram-comment-upper', DARK, 'upper'],
    ['keyboard/instagram-comment-numbers', DARK, 'numbers'],
    ['keyboard/instagram-comment-symbols', DARK, 'symbols'],
    // Back from "ABC": shift lit up over lowercase letters (it typed lowercase).
    ['keyboard/instagram-comment-after-abc', DARK, 'lower'],
    // After typing a letter the accent key reads ` instead of ´.
    ['comment-sheet/instagram-typed', DARK, 'lower'],
    ['keyboard/facebook-comment-lower', LIGHT, 'lower'],
    ['keyboard/facebook-comment-upper', LIGHT, 'upper'],
    ['keyboard/facebook-comment-numbers', LIGHT, 'numbers'],
    ['keyboard/facebook-comment-symbols', LIGHT, 'symbols'],
    ['keyboard/facebook-comment-after-abc', LIGHT, 'lower'],
    ['comment-sheet/facebook-typed', LIGHT, 'lower'],
] as const) {
    test(`matches ${file} to ${set}/${layer} only`, async () => {
        const match = await matchKeyboard(await shot(file), await keyboardReferences());
        assert.equal(match?.reference.name, set);
        assert.equal(match?.layer.name, layer);
        assert.equal(match?.worst, 0);
    });
}

test('no keyboard on screen reads as closed', async () => {
    for (const file of ['comment-sheet/instagram-empty', 'instagram-reels/reel-progress-17', 'tiktok-account/own-profile']) {
        assert.equal((await readKeyboardScreenshot(await shot(file), await keyboardReferences(), 2)).state, 'closed', file);
    }
});

/** The Instagram letters keyboard with its "#" key painted over (a layout without it). */
async function withoutHashKey(): Promise<Buffer> {
    const image = await shot('keyboard/instagram-comment-lower');
    // "#": x 728..818, y 1542..1633 px. Painted with the keyboard background.
    const patch = await sharp({ create: { width: 92, height: 94, channels: 3, background: { r: 49, g: 49, b: 49 } } }).png().toBuffer();
    return sharp(image).composite([{ input: patch, left: 727, top: 1541 }]).jpeg({ quality: 90 }).toBuffer();
}

test('a keyboard that differs by one key matches no reference', async () => {
    const read = await readKeyboardScreenshot(await withoutHashKey(), await keyboardReferences(), 2);
    assert.equal(read.state, 'unknown');
});

test('a keyboard with no reference of its own (light, when only dark is known) is unknown, not closed', async () => {
    const darkOnly = (await keyboardReferences()).filter((reference) => reference.name === DARK);
    assert.equal((await readKeyboardScreenshot(await shot('keyboard/facebook-comment-lower'), darkOnly, 2)).state, 'unknown');
});

test('an unknown keyboard throws KeyboardLayoutMismatch after a few looks, and saves it', async () => {
    const unknown = await withoutHashKey();
    let looks = 0;
    const saved: Buffer[] = [];
    const keyboard = new ScreenKeyboard({
        screenshot: async () => { looks += 1; return unknown; },
        scale: 2,
        perform: async () => {},
        sleep: async () => {},
        saveMismatch: async (screenshot) => { saved.push(screenshot); return '/tmp/mismatch.png'; },
    });
    await assert.rejects(keyboard.readKeyboard(), KeyboardLayoutMismatch);
    assert.equal(looks, 4);
    assert.equal(saved.length, 1);
});

test('no keyboard: readKeyboard is empty (the engine then says it is not open)', async () => {
    const sheet = await shot('comment-sheet/instagram-empty');
    const keyboard = new ScreenKeyboard({ screenshot: async () => sheet, scale: 2, perform: async () => {}, sleep: async () => {} });
    assert.deepEqual(await keyboard.readKeyboard(), []);
});

/**
 * A phone that shows the keyboard screenshot of the current layer and
 * switches layers like iOS when its layer keys are tapped. Taps are matched
 * to the reference keys they land on; what they type is recorded.
 */
async function simulatedPhone(app: 'instagram' | 'facebook', reference: KeyboardReference, start: 'lower' | 'upper') {
    const shots = Object.fromEntries(await Promise.all((['lower', 'upper', 'numbers', 'symbols'] as const)
        .map(async (layer) => [layer, await shot(`keyboard/${app}-comment-${layer}`)] as const)));
    let layer: string = start;
    let typed = '';
    const press = (x: number, y: number) => {
        const key = reference.layers.find((item) => item.name === layer)!.keys
            .find(({ rect }) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height);
        assert.ok(key, `tap at (${x}, ${y}) hits no key on ${layer}`);
        assert.ok(!key.volatile || key.label === 'shift', `typed on a left-out key: ${key.label}`);
        if (key.label === '123') layer = 'numbers';
        else if (key.label === 'ABC') layer = 'lower';
        else if (key.label === '#+=') layer = 'symbols';
        else if (key.label === 'shift') layer = layer === 'lower' ? 'upper' : 'lower';
        else if (key.label === 'espace') { typed += ' '; if (layer !== 'upper') layer = 'lower'; }
        else { typed += key.label; if (layer === 'upper') layer = 'lower'; }
    };
    const taps = (actions: PointerAction[]) => {
        let at: { x: number; y: number } | undefined;
        for (const action of actions) {
            if (action.type === 'pointerMove') at = { x: action.x, y: action.y };
            if (action.type === 'pointerDown' && at) press(at.x, at.y);
        }
    };
    const keyboard = new ScreenKeyboard({
        screenshot: async () => shots[layer]!,
        scale: 2,
        perform: async (actions) => taps(actions),
        performSequence: async (actions) => { taps(actions); return true; },
        sleep: async () => {},
    });
    return { keyboard, typed: () => typed };
}

const instant = { typoRate: 0, wpm: 40, sleep: async () => {}, random: () => 0.5 };

test('types on the matched keyboard, using the comment box\'s own @ key on Instagram', async () => {
    const reference = (await keyboardReferences()).find((item) => item.name === DARK)!;
    const phone = await simulatedPhone('instagram', reference, 'upper');
    await typeOnKeyboard(phone.keyboard, 'trop bien @ami 2', instant);
    assert.equal(phone.typed(), 'trop bien @ami 2');
});

test('types on the default keyboard, going through 123 for @ and digits on Facebook', async () => {
    const reference = (await keyboardReferences()).find((item) => item.name === LIGHT)!;
    const phone = await simulatedPhone('facebook', reference, 'lower');
    await typeOnKeyboard(phone.keyboard, 'la partie 3 @toi', instant);
    assert.equal(phone.typed(), 'la partie 3 @toi');
});
