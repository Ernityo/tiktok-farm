// Replays a recorded agentic doomscroll run through OpenRouter models, with
// the same prompt and code-side skips as the live runner, and compares each
// model's watch choice with the one recorded in the run. Use it to try a
// model, a niche wording or a prompt change without the phone.
//
//   npm run agent:bench -- .agent-runs/<run> [--model a --model b] [--niche "..."] [--language French]
//
// The niche defaults to the run account's current saved niche (devices.json),
// falling back to the niche the run was recorded with. Needs OPENROUTER_API_KEY.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { loadRegisteredDevices } from '@git-agni/phone-farm-core';

import { AGENT_ADAPTERS } from './adapters.js';
import { DEFAULT_AGENT_MODEL, OpenRouterDecider, systemPrompt, type AgentApp } from './model.js';
import { autoSkipReason, engagementAllowance, type AgentPlan } from './plan.js';
import { PROFILES, type Personality } from '../tiktok/doomscroll-profile.js';
import { nicheForAccount, type Niche } from '../tiktok/niche.js';

interface RecordedSession {
    /** Missing on runs recorded before Facebook/Instagram support: TikTok. */
    app?: AgentApp;
    udid?: string;
    account?: string;
    niche: Niche;
    personality: Personality;
}

interface RecordedDecision {
    video: number;
    caption: string;
    isAd: boolean;
    plan: AgentPlan;
    /** Why the run skipped it without the model ('ad', 'card', 'foreign', 'model-error', ...). */
    auto?: string;
}

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        model: { type: 'string', multiple: true },
        niche: { type: 'string' },
        language: { type: 'string', default: 'French' },
    },
});

const runDir = positionals[0];
if (!runDir) throw new Error('Usage: npm run agent:bench -- .agent-runs/<run> [--model ...] [--niche "..."] [--language French]');
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error('Set OPENROUTER_API_KEY in .env');
const models = values.model?.length ? values.model : [DEFAULT_AGENT_MODEL];

const session = JSON.parse(await readFile(path.join(runDir, 'session.json'), 'utf8')) as RecordedSession;
const app: AgentApp = session.app ?? 'tiktok';
const canSave = AGENT_ADAPTERS[app].canSave;
const decisions = (await readFile(path.join(runDir, 'decisions.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line) as RecordedDecision);

async function currentNiche(): Promise<{ niche: Niche; source: string }> {
    if (values.niche) return { niche: { description: values.niche, keywords: [], avoid: [] }, source: '--niche' };
    if (session.account) {
        const device = (await loadRegisteredDevices()).find((entry) => entry.udid === session.udid);
        const saved = nicheForAccount(device, session.account, AGENT_ADAPTERS[app].pluginId) ?? nicheForAccount(device, session.account);
        if (saved) return { niche: saved, source: `saved niche of ${session.account}` };
    }
    return { niche: session.niche, source: 'niche recorded with the run' };
}

const { niche, source } = await currentNiche();
const personality = session.personality;
const profile = PROFILES[personality];
console.log(`[bench] ${decisions.length} ${app} videos from ${runDir}`);
console.log(`[bench] ${source}: ${niche.description}${niche.avoid.length ? ` · avoid: ${niche.avoid.join(', ')}` : ''} · ${personality} · language: ${values.language}`);

const optional = async (file: string) => readFile(file).catch(() => undefined);
const percentile = (sorted: number[], share: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];

for (const model of models) {
    const decider = new OpenRouterDecider(apiKey, model, systemPrompt(niche, personality, values.language, app));
    console.log(`\n[bench] ${model}`);
    const times: number[] = [];
    let same = 0;
    let likes = 0;
    let saves = 0;
    let foreign = 0;
    let errors = 0;
    for (const [index, recorded] of decisions.entries()) {
        const stem = path.join(runDir, String(recorded.video).padStart(4, '0'));
        let watch: string;
        let note: string;
        // Cards and translated captions were spotted on the phone; the model never saw them.
        const skip = autoSkipReason(recorded) ?? (recorded.auto && recorded.auto !== 'model-error' ? recorded.auto : undefined);
        if (skip) {
            watch = 'skip';
            note = `auto: ${skip}`;
        } else {
            const image = await optional(`${stem}.jpg`);
            if (!image) {
                console.log(`#${String(recorded.video).padStart(3)} (no screenshot)`);
                continue;
            }
            const captionImage = await optional(`${stem}-caption.jpg`);
            const judged = index + 1;
            try {
                const decision = await decider.decide({
                    video: recorded.video,
                    image,
                    ...(captionImage ? { captionImage } : {}),
                    caption: recorded.caption,
                    isAd: recorded.isAd,
                    engagement: {
                        likes, likesAllowed: engagementAllowance(judged, profile.likeChance),
                        saves, savesAllowed: canSave ? engagementAllowance(judged, profile.saveChance) : 0,
                    },
                });
                times.push(decision.ms);
                if (decision.plan.likeAtMs) likes += 1;
                if (decision.plan.save) saves += 1;
                if (decision.foreign) foreign += 1;
                watch = decision.plan.watch;
                note = `${decision.ms} ms · ${decision.plan.onNiche.toFixed(2)}${decision.plan.likeAtMs ? ' like' : ''}${decision.plan.save ? ' save' : ''}${decision.foreign ? ' · not in language' : ''}${decision.provider ? ` · ${decision.provider}` : ''}`;
            } catch (error) {
                errors += 1;
                console.log(`#${String(recorded.video).padStart(3)} ERROR ${error instanceof Error ? error.message : String(error)}`);
                continue;
            }
        }
        const match = watch === recorded.plan.watch;
        if (match) same += 1;
        console.log(`#${String(recorded.video).padStart(3)} ${watch.padEnd(5)} recorded ${recorded.plan.watch.padEnd(5)} ${match ? '  ' : '≠ '} ${note}  ${recorded.caption.slice(0, 50)}`);
    }
    times.sort((a, b) => a - b);
    console.log(`[bench] ${model}: same as recorded ${same}/${decisions.length} · model calls ${times.length}`
        + (times.length ? ` · median ${percentile(times, 0.5)} ms · p90 ${percentile(times, 0.9)} ms · max ${times.at(-1)} ms` : '')
        + ` · likes ${likes} · saves ${saves} · not in language ${foreign}${errors ? ` · errors ${errors}` : ''}`);
}
