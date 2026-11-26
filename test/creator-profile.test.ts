import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { bottomBarFromWords, findCreatorName, readProfileScreen } from '../src/tiktok/creator-profile.js';
import type { SourceNode } from '../src/instagram/reels-screen.js';
import type { OcrWord } from '../src/tiktok/ocr.js';

// Name lines measured on the fixtures (points, iPhone XR at 2×).
const NAME_LINES: Record<string, number> = {
    'post-normal-1.png': 662, 'post-normal-2.png': 723, 'post-normal-3.png': 689, 'post-capcut-caption.png': 662, 'post-striped-background.png': 751,
};

for (const [name, y] of Object.entries(NAME_LINES)) {
    test(`the creator's name is found at the top of the caption: ${name}`, async () => {
        const point = await findCreatorName(await readFile(new URL(`./fixtures/tiktok-ads/${name}`, import.meta.url)), 2);
        assert.ok(point, 'no name found');
        assert.ok(Math.abs(point.y - y) <= 6, `y ${point.y}, expected ~${y}`);
        assert.ok(point.x >= 12 && point.x <= 80, `x ${point.x}`);
    });
}

const word = (text: string): OcrWord => ({ text, x: 0, y: 0, width: 10, height: 10, confidence: 90 });

test('the bottom bar tells the feed, the profile player and other screens apart', () => {
    assert.equal(bottomBarFromWords(['o', 'o', 'Profil'].map(word)), 'feed');
    assert.equal(bottomBarFromWords(['9', 'Amis'].map(word)), 'feed');
    assert.equal(bottomBarFromWords(['Ajouter', 'un', 'commentaire.'].map(word)), 'player');
    assert.equal(bottomBarFromWords(['Vient', "d'étre", 'vue'].map(word)), 'other');
    assert.equal(bottomBarFromWords([]), 'other');
});

const node = (type: string, props: Partial<SourceNode>, rect: [number, number, number, number]): SourceNode => ({
    type, ...props, rect: { x: rect[0] - rect[2] / 2, y: rect[1] - rect[3] / 2, width: rect[2], height: rect[3] },
});

// Trimmed from the real profile tree (centres and sizes as phone_look printed them).
function profileTree(followed: boolean): SourceNode {
    const tiles = followed ? 719 : 484;
    return {
        type: 'Application', children: [
            node('Button', { name: 'nav_bar_start_back', label: 'IconChevronLeftLTR' }, [29, 70, 42, 44]),
            node('Other', { name: 'user_account_user_name', label: '@histoiresfruitees_' }, [73, 146, 114, 16]),
            {
                ...node('Other', { name: 'cta_social_interaction' }, followed ? [138, 238, 243, 40] : [183, 238, 334, 40]),
                children: [followed ? node('Button', { label: 'Message' }, [138, 238, 243, 40]) : node('Button', { label: 'Suivre' }, [159, 238, 286, 40])],
            },
            ...(followed
                ? [
                    node('Button', { name: 'cta_settings_button', label: 'Gérer le profil' }, [309, 238, 83, 40]),
                    // Suggested accounts: their Suivre buttons are not the creator's.
                    node('Button', { label: 'Suivre' }, [90, 465, 124, 32]),
                    node('Button', { label: 'Suivre' }, [242, 465, 124, 32]),
                ]
                : []),
            node('Button', { label: '#histoire #fruitstory #ai . Vidéo. 297 vues.' }, [69, tiles, 137, 182]),
            node('Button', { label: 'Partie 2 | #histoire . Vidéo. 2345 vues.' }, [207, tiles, 138, 182]),
            node('Button', { label: 'Partie 3 | #histoire . Vidéo. 4443 vues.' }, [207, 850, 138, 182]),
        ],
    };
}

test('the profile shows its own Suivre button and the tiles fully on screen', () => {
    const profile = readProfileScreen(profileTree(false), 896);
    assert.ok(profile);
    assert.equal(profile.handle, '@histoiresfruitees_');
    assert.deepEqual(profile.follow, { x: 159, y: 238 });
    assert.equal(profile.following, false);
    assert.deepEqual(profile.back, { x: 29, y: 70 });
    // The 850 row runs off the bottom of the screen.
    assert.deepEqual(profile.videos, [{ x: 69, y: 484 }, { x: 207, y: 484 }]);
});

test('after following, suggested accounts\' Suivre buttons are ignored', () => {
    const profile = readProfileScreen(profileTree(true), 896)!;
    assert.equal(profile.follow, undefined);
    assert.equal(profile.following, true);
});

test('a screen without a creator handle is not a profile', () => {
    assert.equal(readProfileScreen({ type: 'Application', children: [node('Button', { label: 'Suivre' }, [159, 238, 286, 40])] }, 896), undefined);
});
