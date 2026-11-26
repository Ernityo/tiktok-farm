import assert from 'node:assert/strict';
import test from 'node:test';

import { engagementAllowance, finalLingerMs, sameCaption, sessionLengthMs, swipeRecord, timePlan, WATCH_RANGES, withinBudget } from '../src/agent/plan.js';
import { feedDidNotMove } from '../src/agent/session.js';
import { parseReply, systemPrompt, userText } from '../src/agent/model.js';
import { accountNiches, nicheForAccount, parseNiche, pruneNiches } from '../src/tiktok/niche.js';
import type { RegisteredDevice } from '../src/types.js';

function device(niches: unknown): RegisteredDevice {
    return { name: 'phone', udid: 'u1', pluginData: { 'com.git-agni.tiktok': { accounts: ['@a'], niches } } } as unknown as RegisteredDevice;
}

test('parseNiche trims, splits comma strings and dedupes', () => {
    assert.deepEqual(parseNiche({ description: '  calisthenics ', keywords: 'pull up, push up, pull up', avoid: [' dance ', ''] }), {
        description: 'calisthenics', keywords: ['pull up', 'push up'], avoid: ['dance'],
    });
});

test('parseNiche keeps an optional persona', () => {
    assert.equal(parseNiche({ description: 'x', persona: '  barista, 30  ' }).persona, 'barista, 30');
    assert.equal('persona' in parseNiche({ description: 'x', persona: ' ' }), false);
    assert.throws(() => parseNiche({ description: 'x', persona: 'a'.repeat(501) }), /Persona/);
});

test('parseNiche rejects an empty description and bad lists', () => {
    assert.throws(() => parseNiche({ description: '  ' }), /Describe the niche/);
    assert.throws(() => parseNiche({ description: 'x', keywords: [1] }), /list of strings/);
    assert.throws(() => parseNiche(null), /must be an object/);
});

test('accountNiches normalizes handles and skips broken entries', () => {
    const niches = accountNiches(device({ a: { description: 'cooking' }, '@b': { description: '' }, '@c': 'oops' }));
    assert.deepEqual(Object.keys(niches), ['@a']);
    assert.equal(nicheForAccount(device({ '@a': { description: 'cooking' } }), 'a')?.description, 'cooking');
    assert.equal(nicheForAccount(device(undefined), '@a'), undefined);
});

test('pruneNiches keeps only configured accounts', () => {
    const niche = { description: 'x', keywords: [], avoid: [] };
    assert.deepEqual(Object.keys(pruneNiches({ '@a': niche, '@b': niche }, ['a'])), ['@a']);
});

function sequence(...values: number[]): () => number {
    let index = 0;
    return () => values[index++ % values.length]!;
}

test('skipped videos are never liked or saved', () => {
    const timed = timePlan({ onNiche: 0.1, watch: 'skip', likeAtMs: 1000, save: true }, 'engaged', undefined, () => 0.5);
    assert.deepEqual(Object.keys(timed), ['watchMs']);
    const [min, max] = WATCH_RANGES.engaged.skip;
    assert.ok(timed.watchMs >= min && timed.watchMs <= max);
});

test('likes and saves fit before the swipe, save after like', () => {
    for (let seed = 0; seed < 50; seed += 1) {
        const random = sequence(seed / 50, 0.99, 0.3, 0.99, 0.7);
        const timed = timePlan({ onNiche: 0.9, watch: 'short', likeAtMs: 9000, save: true }, 'engaged', undefined, random);
        if (timed.likeAtMs !== undefined) assert.ok(timed.likeAtMs < timed.watchMs);
        if (timed.saveAtMs !== undefined) {
            assert.ok(timed.saveAtMs < timed.watchMs);
            if (timed.likeAtMs !== undefined) assert.ok(timed.saveAtMs > timed.likeAtMs);
        }
    }
});

test('a planned like is sometimes dropped', () => {
    // random() < drop chance on the like draw.
    const timed = timePlan({ onNiche: 0.9, watch: 'full', likeAtMs: 3000 }, 'engaged', undefined, sequence(0.5, 0.01));
    assert.equal(timed.likeAtMs, undefined);
});

test('a planned like is never cut short: the watch stretches to fit it', () => {
    const timed = timePlan({ onNiche: 0.9, watch: 'short', likeAtMs: 20_000 }, 'skimmer', undefined, () => 0.99);
    assert.ok(timed.likeAtMs !== undefined && timed.likeAtMs < timed.watchMs);
});

test('session length varies around the asked minutes', () => {
    assert.equal(sessionLengthMs(10, () => 0), 510_000);
    assert.equal(sessionLengthMs(10, () => 0.5), 600_000);
    assert.equal(sessionLengthMs(10, () => 1), 690_000);
    const linger = finalLingerMs(() => 0.5);
    assert.ok(linger >= 1500 && linger <= 5000);
});

test('the personality caps likes and saves over the session', () => {
    // casual: 18% likes, 6% saves. After 9 judged videos with 2 likes, a 10th like is over budget.
    assert.equal(withinBudget(2, 10, 0.18), false);
    assert.equal(withinBudget(1, 10, 0.18), true);
    // The first on-niche video can always be liked.
    assert.equal(withinBudget(0, 1, 0.08), true);
    const timed = timePlan(
        { onNiche: 0.9, watch: 'full', likeAtMs: 3000, save: true }, 'casual', { judged: 9, likes: 2, saves: 1 }, () => 0.5,
    );
    assert.equal(timed.likeAtMs, undefined);
    assert.equal(timed.saveAtMs, undefined);
});

test('a casual agent following every like plan lands near 18%', () => {
    let likes = 0;
    for (let judged = 0; judged < 100; judged += 1) {
        const timed = timePlan({ onNiche: 0.9, watch: 'full', likeAtMs: 3000 }, 'casual', { judged, likes, saves: 0 }, () => 0.5);
        if (timed.likeAtMs !== undefined) likes += 1;
    }
    assert.ok(likes >= 16 && likes <= 19, `likes=${likes}`);
});

test('the like allowance grows with videos judged and always allows one', () => {
    assert.equal(engagementAllowance(1, 0.17), 1);
    assert.equal(engagementAllowance(10, 0.17), 2);
    assert.equal(engagementAllowance(28, 0.17), 5);
});

test('a stuck swipe shows the same caption, even with OCR noise', () => {
    assert.ok(sameCaption(
        '@ BLACK FRIDAY - CP - Eau de parfum 50... By Enzo Commission payée - )',
        'BLACK FRIDAY - CP - Eau de parfum 50... By Enzo Commission payée - )',
    ));
});

test('different videos, even from one series, are not the same caption', () => {
    assert.ok(!sameCaption(
        'Salade2fruits Partie 2 Elle s’est fait refaire la tête pour qu on arrête de se moquer',
        'Salade2fruits Elle a menti sur sa photo pour avoir son premier rendez-vous',
    ));
    // Too little text to tell.
    assert.ok(!sameCaption('Angel.', 'Angel.'));
});

test('a model reply becomes a plan, with the like timing chosen in code', () => {
    const { plan, foreign } = parseReply('{"foreign": false, "on_niche": 0.9, "watch": "full", "like": true, "save": false}', () => 0.5);
    assert.deepEqual(plan, { onNiche: 0.9, watch: 'full', likeAtMs: 7000, save: false });
    assert.equal(foreign, false);
});

test('likes and saves on anything but a full watch are dropped', () => {
    const { plan } = parseReply('```json\n{"on_niche": 0.4, "watch": "short", "like": true, "save": true}\n```');
    assert.deepEqual(plan, { onNiche: 0.4, watch: 'short', likeAtMs: null, save: false });
});

test('a reply without a valid watch choice is rejected', () => {
    assert.throws(() => parseReply('{"on_niche": 0.4, "watch": "maybe"}'));
    assert.throws(() => parseReply('not json'));
});

test('the system prompt carries the niche and its avoid list', () => {
    const prompt = systemPrompt({ description: 'animated AI dramas', keywords: [], avoid: ['politics'] }, 'casual');
    assert.match(prompt, /niche: animated AI dramas/);
    assert.match(prompt, /avoid: politics/);
});

test('a video not in the account language is skipped whatever the model planned', () => {
    const { plan, foreign } = parseReply('{"foreign": true, "on_niche": 0.95, "watch": "full", "like": true}');
    assert.equal(foreign, true);
    assert.deepEqual(plan, { onNiche: 0, watch: 'skip', likeAtMs: null, save: false });
});

test('facebook and instagram prompts name the feed and never ask for saves', () => {
    const niche = { description: 'cats', keywords: [], avoid: [] };
    for (const [app, feed] of [['facebook', 'Facebook Reels feed'], ['instagram', 'Instagram Reels feed']] as const) {
        const prompt = systemPrompt(niche, 'casual', 'French', app);
        assert.match(prompt, new RegExp(feed));
        assert.doesNotMatch(prompt, /save/i);
        assert.match(prompt, /Sponsoris/);
    }
    assert.match(systemPrompt(niche, 'casual', 'French', 'facebook'), /Afficher l'original/);
    assert.match(systemPrompt(niche, 'casual'), /"save": true\|false/);
});

test('userText leaves saves out when none are allowed', () => {
    const base = { video: 1, image: Buffer.alloc(0), caption: 'x', isAd: false };
    assert.match(userText({ ...base, engagement: { likes: 1, likesAllowed: 2, saves: 0, savesAllowed: 1 } }), /saves 0\/1/);
    assert.doesNotMatch(userText({ ...base, engagement: { likes: 1, likesAllowed: 2, saves: 0, savesAllowed: 0 } }), /saves/);
});

test('nicheForAccount reads another plugin\'s niches when asked', () => {
    const phone = {
        name: 'phone', udid: 'u1',
        pluginData: { 'com.git-agni.facebook': { niches: { '@a': { description: 'fb niche' } } } },
    } as unknown as RegisteredDevice;
    assert.equal(nicheForAccount(phone, '@a', 'com.git-agni.facebook')?.description, 'fb niche');
    assert.equal(nicheForAccount(phone, '@a'), undefined);
});

test('swipeRecord logs where the finger went and the upward distance', () => {
    assert.deepEqual(swipeRecord('right-thumb', { start: { x: 300, y: 480 }, end: { x: 320, y: 370 }, durationMs: 150 }), {
        style: 'right-thumb', from: { x: 300, y: 480 }, to: { x: 320, y: 370 }, dy: 110, ms: 150,
    });
});

test('feedDidNotMove compares captions; a different id means the feed moved', () => {
    const caption = 'creator name morning routine gym motivation leg day';
    assert.equal(feedDidNotMove({ caption }, { caption }), true);
    assert.equal(feedDidNotMove({ caption }, { caption: 'another person cooking pasta dinner recipe tonight' }), false);
    // Same caption but another id: moved on.
    assert.equal(feedDidNotMove({ caption, reelId: 'Reel de a.' }, { caption, reelId: 'Reel de b.' }), false);
    // Instagram ids name the creator: the next part of a series has the same id but a new caption.
    assert.equal(feedDidNotMove(
        { caption: 'htmfr_d Suivre THE MASK Partie 3 #ia #aistory', reelId: 'Reel de htmfr_d.' },
        { caption: 'htmfr_d Suivre Le roi perd sa couronne dans la forêt enchantée #fantasy', reelId: 'Reel de htmfr_d.' },
    ), false);
    assert.equal(feedDidNotMove({ caption, reelId: 'Reel de a.' }, { caption, reelId: 'Reel de a.' }), true);
    // Too little text to tell (cards): moved on.
    assert.equal(feedDidNotMove({ caption: 'Suivre' }, { caption: 'Suivre' }), false);
});
