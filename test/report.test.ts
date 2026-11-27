import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadRun, writeRunReport } from '../src/agent/report.js';

const spans = {
    screenshot: [0, 300], images: [300, 340], ocr: [300, 700], inspect: [300, 650], observed: 710,
    model: [340, 1050], decided: 1060, watched: 1500, swipe: [1500, 1700], end: 1700,
};

async function runFolder(): Promise<{ runs: string; run: string }> {
    const runs = await mkdtemp(path.join(os.tmpdir(), 'agent-runs-'));
    const run = path.join(runs, '2026-11-27T05-00-00-000Z-facebook-someone');
    await mkdir(run);
    await writeFile(path.join(run, 'session.json'), JSON.stringify({
        app: 'facebook', account: '@someone', personality: 'casual', source: 'runner', settings: { settleMs: 0, earlyDecide: true },
        startedAt: '2026-11-27T05:00:00.000Z',
    }));
    const lines = [
        { video: 1, caption: 'a </script><b>caption', plan: { onNiche: 0.1, watch: 'skip' }, timed: { watchMs: 1200 }, screenMs: 1700, modelMs: 710, model: 'm', spans },
        { video: 2, caption: 'ad', plan: { onNiche: 0, watch: 'skip' }, auto: 'ad', screenMs: 1500 },
        'not json',
    ];
    await writeFile(path.join(run, 'decisions.jsonl'), `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`);
    return { runs, run };
}

test('a run folder loads with its source, settings and step timings', async () => {
    const { runs, run } = await runFolder();
    try {
        const loaded = await loadRun(run);
        assert.equal(loaded?.source, 'runner');
        assert.deepEqual(loaded?.settings, { settleMs: 0, earlyDecide: true });
        assert.equal(loaded?.model, 'm');
        assert.equal(loaded?.videos.length, 2, 'the broken line is dropped');
        assert.deepEqual(loaded?.videos[0]?.spans, spans);
        assert.equal(loaded?.videos[0]?.watchMs, 1200);
        assert.equal(loaded?.videos[1]?.auto, 'ad');
    } finally {
        await rm(runs, { recursive: true, force: true });
    }
});

test('the run report and the index are written as self-contained pages', async () => {
    const { runs, run } = await runFolder();
    try {
        const file = await writeRunReport(run);
        const page = await readFile(file!, 'utf8');
        assert.match(page, /<script id="data" type="application\/json">/);
        assert.doesNotMatch(page, /a <\/script><b>caption/, 'captions cannot close the data script');
        assert.doesNotMatch(page, /<script src=|<link /, 'no external files');
        const index = await readFile(path.join(runs, 'index.html'), 'utf8');
        assert.match(index, /"kind":"index"/);
    } finally {
        await rm(runs, { recursive: true, force: true });
    }
});
