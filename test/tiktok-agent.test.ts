import assert from 'node:assert/strict';
import test from 'node:test';

import { engagementAllowance, sameCaption, timePlan, WATCH_RANGES, withinBudget } from '../src/tiktok/agent-plan.js';
import { parseReply, systemPrompt } from '../src/tiktok/agent-model.js';
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
    const timed = timePlan({ onNiche: 0.1, watch: 'skip', likeAtMs: 1000, save: true }, 60_000, 'engaged', undefined, () => 0.5);
    assert.deepEqual(Object.keys(timed), ['watchMs']);
    const [min, max] = WATCH_RANGES.engaged.skip;
    assert.ok(timed.watchMs >= min && timed.watchMs <= max);
});

test('likes and saves fit before the swipe, save after like', () => {
    for (let seed = 0; seed < 50; seed += 1) {
        const random = sequence(seed / 50, 0.99, 0.3, 0.99, 0.7);
        const timed = timePlan({ onNiche: 0.9, watch: 'short', likeAtMs: 9000, save: true }, 60_000, 'engaged', undefined, random);
        if (timed.likeAtMs !== undefined) assert.ok(timed.likeAtMs < timed.watchMs);
        if (timed.saveAtMs !== undefined) {
            assert.ok(timed.saveAtMs < timed.watchMs);
            if (timed.likeAtMs !== undefined) assert.ok(timed.saveAtMs > timed.likeAtMs);
        }
    }
});

test('a planned like is sometimes dropped', () => {
    // random() < drop chance on the like draw.
    const timed = timePlan({ onNiche: 0.9, watch: 'full', likeAtMs: 3000 }, 60_000, 'engaged', undefined, sequence(0.5, 0.01));
    assert.equal(timed.likeAtMs, undefined);
});

test('timings never run past the session deadline', () => {
    const timed = timePlan({ onNiche: 0.9, watch: 'full', likeAtMs: 5000, save: true }, 2000, 'engaged', undefined, () => 0.99);
    assert.ok(timed.watchMs <= 2000);
    assert.equal(timed.likeAtMs, undefined);
});

test('the personality caps likes and saves over the session', () => {
    // casual: 18% likes, 6% saves. After 9 judged videos with 2 likes, a 10th like is over budget.
    assert.equal(withinBudget(2, 10, 0.18), false);
    assert.equal(withinBudget(1, 10, 0.18), true);
    // The first on-niche video can always be liked.
    assert.equal(withinBudget(0, 1, 0.08), true);
    const timed = timePlan(
        { onNiche: 0.9, watch: 'full', likeAtMs: 3000, save: true }, 60_000, 'casual', { judged: 9, likes: 2, saves: 1 }, () => 0.5,
    );
    assert.equal(timed.likeAtMs, undefined);
    assert.equal(timed.saveAtMs, undefined);
});

test('a casual agent following every like plan lands near 18%', () => {
    let likes = 0;
    for (let judged = 0; judged < 100; judged += 1) {
        const timed = timePlan({ onNiche: 0.9, watch: 'full', likeAtMs: 3000 }, 60_000, 'casual', { judged, likes, saves: 0 }, () => 0.5);
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
