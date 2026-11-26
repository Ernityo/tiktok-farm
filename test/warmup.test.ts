import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseReply, systemPrompt, userText } from '../src/agent/model.js';
import { searchQuery } from '../src/agent/warmup.js';
import { PluginRegistry } from '../src/registry.js';
import { createTikTokPlugin } from '../src/tiktok-plugin.js';
import { nichesToJson, parseNiche } from '../src/tiktok/niche.js';
import { dailyFeedShare, searchedOn, warmupRuns } from '../src/tiktok/warmup-history.js';
import {
    followAllowance, parseWarmup, warmupDay, warmupPhase, warmupStartDate,
} from '../src/tiktok/warmup.js';

const niche = { description: 'animated AI dramas', keywords: ['#aidrama', 'ai story'], avoid: ['politics'], persona: '30-year-old Paris barista' };

test('a saved niche keeps its persona', () => {
    assert.equal(parseNiche(nichesToJson({ '@a': niche })['@a']).persona, '30-year-old Paris barista');
});

test('warm-up days count calendar days in the warm-up timezone', () => {
    const state = { startedOn: '2026-11-26', timezone: 'Europe/Paris' };
    assert.equal(warmupDay(state, new Date('2026-11-26T06:00:00Z')), 1);
    // 23:30 UTC on the 26th is already the 27th in Paris.
    assert.equal(warmupDay(state, new Date('2026-11-26T23:30:00Z')), 2);
    assert.equal(warmupDay(state, new Date('2026-11-25T12:00:00Z')), 0);
    assert.deepEqual([1, 2, 3, 5, 6].map(warmupPhase), ['persona', 'persona', 'niche', 'niche', 'done']);
});

test('day 1 starts tomorrow once the first session of today has passed', () => {
    const times = ['12:45', '08:30', '20:00'];
    assert.equal(warmupStartDate(new Date('2026-11-26T06:00:00Z'), 'Europe/Paris', times), '2026-11-26'); // 07:00 Paris
    assert.equal(warmupStartDate(new Date('2026-11-26T14:00:00Z'), 'Europe/Paris', times), '2026-11-27'); // 15:00 Paris
    assert.equal(warmupStartDate(new Date('2026-12-31T20:00:00Z'), 'Europe/Paris', times), '2027-01-01');
});

test('parseWarmup rejects bad dates and timezones', () => {
    assert.deepEqual(parseWarmup({ startedOn: '2026-11-26', timezone: 'Europe/Paris' }), { startedOn: '2026-11-26', timezone: 'Europe/Paris' });
    assert.throws(() => parseWarmup({ startedOn: '26/11/2026', timezone: 'UTC' }), /YYYY-MM-DD/);
    assert.throws(() => parseWarmup({ startedOn: '2026-11-26', timezone: 'Mars/Olympus' }), /timezone/);
});

test('follows are paced over the session', () => {
    assert.equal(followAllowance(5, 0), 1);
    assert.equal(followAllowance(5, 0.5), 3);
    assert.equal(followAllowance(5, 1.4), 5);
    assert.equal(followAllowance(0, 0.5), 0);
});

test('the persona prompt teaches the persona and never asks for comments', () => {
    const prompt = systemPrompt(niche, 'casual', 'French', 'instagram', { goal: 'persona', follows: true, noComments: true });
    assert.match(prompt, /who this person is/);
    assert.match(prompt, /Paris barista/);
    assert.match(prompt, /"follow": true\|false/);
    assert.doesNotMatch(prompt, /"comment"/);
    assert.doesNotMatch(prompt, /animated AI dramas/);
    assert.match(prompt, /avoid: politics/);
    assert.throws(() => systemPrompt({ ...niche, persona: undefined }, 'casual', 'French', 'tiktok', { goal: 'persona' }), /persona/);
    assert.doesNotMatch(systemPrompt(niche, 'casual'), /"follow"/);
});

test('follows are only kept on full watches and shown while some are left', () => {
    assert.equal(parseReply('{"on_niche":0.9,"watch":"full","follow":true}').plan.follow, true);
    assert.equal(parseReply('{"on_niche":0.9,"watch":"short","follow":true}').plan.follow, undefined);
    const base = { video: 1, image: Buffer.alloc(0), caption: '', isAd: false };
    assert.match(userText({ ...base, engagement: { likes: 0, likesAllowed: 1, saves: 0, savesAllowed: 0, follows: 1, followsAllowed: 2 } }), /follows 1\/2 allowed/);
    assert.doesNotMatch(userText({ ...base, engagement: { likes: 0, likesAllowed: 1, saves: 0, savesAllowed: 0, follows: 2, followsAllowed: 2 } }), /follows/);
});

test('the search query is a niche keyword, else a short description', () => {
    assert.equal(searchQuery(niche, () => 0), 'aidrama');
    assert.equal(searchQuery({ ...niche, keywords: [] }), 'animated AI dramas');
    assert.equal(searchQuery({ ...niche, keywords: [], description: 'x'.repeat(60) }), undefined);
});

test('warm-up runs are read from the run logs', async () => {
    const runs = await mkdtemp(path.join(os.tmpdir(), 'warmup-runs-'));
    try {
        const write = async (name: string, session: object, summary?: object) => {
            await mkdir(path.join(runs, name));
            await writeFile(path.join(runs, name, 'session.json'), JSON.stringify(session));
            if (summary) await writeFile(path.join(runs, name, 'summary.json'), JSON.stringify(summary));
        };
        await write('2026-11-28T07-00-00-000Z-tiktok-a', { udid: 'u1', startedAt: '2026-11-28T07:00:00Z' },
            { feedVideos: 40, feedOnNicheShare: 0.5, follows: 5, search: { query: 'ai story', videos: 6 }, meta: { warmup: { phase: 'niche', day: 3 } } });
        await write('2026-11-28T11-00-00-000Z-tiktok-a', { udid: 'u1', startedAt: '2026-11-28T11:00:00Z' },
            { feedVideos: 60, feedOnNicheShare: 0.6, follows: 4, meta: { warmup: { phase: 'niche', day: 3 } } });
        await write('2026-11-28T15-00-00-000Z-tiktok-a', { udid: 'u1', startedAt: '2026-11-28T15:00:00Z' }); // no summary yet
        await write('2026-11-28T16-00-00-000Z-tiktok-a', { udid: 'other', startedAt: '2026-11-28T16:00:00Z' }, { feedVideos: 9 });
        await write('2026-11-25T07-00-00-000Z-tiktok-a', { udid: 'u1', startedAt: '2026-11-25T07:00:00Z' }, { feedVideos: 9 }); // before the start
        const found = await warmupRuns('u1', '@a', { startedOn: '2026-11-26', timezone: 'Europe/Paris' }, runs);
        assert.equal(found.length, 2);
        assert.equal(searchedOn(found, '2026-11-28'), true);
        assert.equal(searchedOn(found, '2026-11-29'), false);
        assert.deepEqual(dailyFeedShare(found), [{ date: '2026-11-28', videos: 100, share: 0.56 }]);
    } finally {
        await rm(runs, { recursive: true, force: true });
    }
});

test('the TikTok plugin validates warm-up tasks', () => {
    const plugin = createTikTokPlugin({ warmupEntrypoint: '/example/warmup.js' });
    const registry = new PluginRegistry([plugin]);
    const request = (payload: object) => ({
        deviceUdid: 'device-12345678',
        task: { pluginId: plugin.id, taskType: 'warmup', taskVersion: 1, payload },
        timing: { kind: 'daily', localTime: '08:30', timezone: 'Europe/Paris' },
    });
    assert.deepEqual(registry.validate(request({ account: 'fitjulie' }) as never).task.payload, { account: '@fitjulie', durationMinutes: 10, personality: 'casual' });
    assert.throws(() => registry.validate(request({ account: '@a', durationMinutes: 90 }) as never), /between 3 and 30/);
    assert.throws(() => registry.validate(request({}) as never), /account/);
});
