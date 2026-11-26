import assert from 'node:assert/strict';
import test from 'node:test';

import type { SourceNode } from '../src/instagram/reels-screen.js';
import { profileHandle, sameHandle, switcherButton, switcherOpen, switcherRow, tabButton } from '../src/tiktok/account.js';
import type { OcrWord } from '../src/tiktok/ocr.js';

// Trimmed from WDA's JSON page source of TikTok's Profile tab (French app,
// iPhone XR, 2026-11-26), with the labels and frames as recorded.
function node(type: string, rect: [number, number, number, number], extra: Partial<SourceNode> = {}, children: SourceNode[] = []): SourceNode {
    const [x, y, width, height] = rect;
    return { type, isVisible: '1', rect: { x, y, width, height }, children, ...extra };
}

function profileTree(handle: string): SourceNode {
    return node('Application', [0, 0, 414, 896], { label: 'TikTok', name: 'TikTok' }, [
        node('Window', [0, 0, 414, 896], { name: 'AWEMaskWindow' }, [
            node('Other', [16, 98, 274, 38], { name: 'user_account_name_info' }, [
                node('StaticText', [17, 98, 157, 38], { label: handle.replace(/^@/, '') }),
                node('Button', [177, 109, 16, 16], { label: 'Changer de compte', name: 'IconArrowTriangleDownLargeFill' }),
            ]),
            node('Other', [16, 138, 75, 16], { label: handle, name: 'user_account_user_name' }),
            node('TabBar', [0, 813, 414, 83], { label: 'Barre d’onglets' }, [
                node('Button', [0, 813, 83, 49], { label: 'Accueil', name: 'a11y_vo_home' }),
                node('Button', [331, 813, 83, 49], { label: 'Profil', name: 'a11y_vo_profile' }),
            ]),
        ]),
    ]);
}

const word = (text: string, x: number, y: number): OcrWord => ({ text, x, y, width: text.length * 18, height: 34, confidence: 90 });

// The switcher sheet, as OCR words in device pixels (scale 2, screen 1792 px tall).
const SHEET: OcrWord[] = [
    word('francois2k', 40, 220), // the profile's own name, top of the screen
    word('Changer', 300, 1155), word('de', 440, 1155), word('compte', 490, 1155),
    word('metafruit67', 206, 1283),
    word('francois2k', 206, 1435),
    word('Ajouter', 206, 1587), word('un', 340, 1587), word('compte', 390, 1587),
];

test('profileHandle reads user_account_user_name', () => {
    assert.equal(profileHandle(profileTree('@metafruit67')), '@metafruit67');
    assert.equal(profileHandle(node('Application', [0, 0, 414, 896])), undefined);
});

test('sameHandle ignores the @ and case', () => {
    assert.equal(sameHandle('@MetaFruit67', 'metafruit67'), true);
    assert.equal(sameHandle('@francois2k', '@metafruit67'), false);
    assert.equal(sameHandle('@', ''), false);
});

test('switcherButton and the tabs are found by their labels', () => {
    const tree = profileTree('@francois2k');
    assert.deepEqual(switcherButton(tree), { x: 185, y: 117 });
    assert.deepEqual(tabButton(tree, 'a11y_vo_home'), { x: 42, y: 838 });
    assert.deepEqual(tabButton(tree, 'a11y_vo_profile'), { x: 373, y: 838 });
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
