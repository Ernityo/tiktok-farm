import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { bottomBarFromWords, findCreatorName, profileHeaderFromWords, readProfileScreenshot } from '../src/tiktok/creator-profile.js';
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

// Real profile screenshots (MCP looks: 500 px wide, so 500/414 px a point).
const profileShot = (name: string) => readFile(new URL(`./fixtures/tiktok-profile/${name}`, import.meta.url));
const LOOK_SCALE = 500 / 414;

test('a profile not yet followed: its own Suivre button and the first row of tiles', async () => {
    const profile = await readProfileScreenshot(await profileShot('profile-not-following.jpg'), LOOK_SCALE);
    assert.ok(profile, 'not read as a profile');
    assert.equal(profile.following, false);
    assert.ok(profile.follow, 'no Suivre button');
    // Measured: the pill is centred at (159, 238) points.
    assert.ok(Math.abs(profile.follow.x - 159) <= 15 && Math.abs(profile.follow.y - 238) <= 6, JSON.stringify(profile.follow));
    assert.equal(profile.videos.length, 3);
    assert.ok(Math.abs(profile.videos[0]!.y - 484) <= 15, JSON.stringify(profile.videos));
});

test('a followed profile: Message instead of Suivre, the suggested accounts\' buttons ignored', async () => {
    const profile = await readProfileScreenshot(await profileShot('profile-following.jpg'), LOOK_SCALE);
    assert.ok(profile, 'not read as a profile');
    assert.equal(profile.follow, undefined);
    assert.equal(profile.following, true);
    // The grid moved below the suggested accounts (centre ~719 points).
    if (profile.videos.length) assert.ok(Math.abs(profile.videos[0]!.y - 719) <= 15, JSON.stringify(profile.videos));
});

for (const name of ['post-normal-1.png', 'follow-back-card.png', 'live-preview.png']) {
    test(`a feed screen is not a profile: ${name}`, async () => {
        const buffer = await readFile(new URL(`./fixtures/tiktok-ads/${name}`, import.meta.url));
        assert.equal(await readProfileScreenshot(buffer, 2), undefined);
    });
}

test('the header words: the stats row makes a profile, Message means following', () => {
    const read = profileHeaderFromWords(['@histoiresfruitees_', '13', 'Suivis', '20,7', 'K', 'Followers', "J'aime"].map(word));
    assert.deepEqual(read, { profile: true, handle: '@histoiresfruitees_', following: false });
    assert.equal(profileHeaderFromWords(['Message', 'Suivis', 'Followers'].map(word)).following, true);
    assert.equal(profileHeaderFromWords(['Suivis', 'Pour', 'toi'].map(word)).profile, false);
});
