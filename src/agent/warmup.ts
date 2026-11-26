// One TikTok warm-up session (see src/tiktok/warmup.ts for the plan): works
// out the account's warm-up day and phase, then runs an agentic session that
// teaches the feed the persona (days 1-2) or the niche (days 3-5, with a
// search once a day). Run by the scheduler's "warmup" task, three times a
// day; also runnable by hand:
//
//   npm run agent:warmup -- --account @handle [--minutes 10] [--personality casual] [--udid ...] [--phase persona|niche] [--dry-run]
//
// --dry-run prints what the session would do without touching the phone.
// Needs OPENROUTER_API_KEY; AGENT_MODEL overrides the model.

import path from 'node:path';
import { parseArgs } from 'node:util';

import { loadRegisteredDevices } from '@git-agni/phone-farm-core';
import type { RegisteredDevice } from '../devices/registry.js';
import { DEFAULT_AGENT_MODEL, OpenRouterDecider, assertGoalFits, systemPrompt, type ScrollGoal } from './model.js';
import { runSession } from './loop.js';
import { AgentSession, resolveDevice, type SearchDetour } from './session.js';
import { tiktokAdapter } from '../tiktok/agent-adapter.js';
import type { Personality } from '../tiktok/doomscroll-profile.js';
import { nicheForAccount, normalizeHandle, type Niche } from '../tiktok/niche.js';
import { searchedOn, warmupRuns } from '../tiktok/warmup-history.js';
import {
    localDate, WARMUP_PLAN, warmupDay, warmupForAccount, warmupPhase, type WarmupPhase, type WarmupState,
} from '../tiktok/warmup.js';

const PERSONALITIES: readonly Personality[] = ['skimmer', 'casual', 'engaged'];
/** A search query longer than this is too long to type; a niche description is only used when shorter. */
const MAX_QUERY_CHARS = 40;

const between = (min: number, max: number) => Math.round(min + Math.random() * (max - min));

export interface WarmupSessionPlan {
    day: number;
    phase: WarmupPhase;
    goal: ScrollGoal;
    follows: number;
    search?: SearchDetour;
    /** Why there is no search in a niche-phase session. */
    noSearchReason?: string;
}

/** A search query from the niche: one of its keywords, else a short description. */
export function searchQuery(niche: Niche, random: () => number = Math.random): string | undefined {
    const keywords = niche.keywords.map((keyword) => keyword.replace(/^#/, '').trim()).filter(Boolean);
    if (keywords.length) return keywords[Math.floor(random() * keywords.length)];
    return niche.description.length <= MAX_QUERY_CHARS ? niche.description : undefined;
}

export async function planWarmupSession(
    device: RegisteredDevice, account: string, state: WarmupState, niche: Niche, options: { phase?: WarmupPhase; now?: Date } = {},
): Promise<WarmupSessionPlan> {
    const now = options.now ?? new Date();
    const day = warmupDay(state, now);
    if (day < 1 && !options.phase) throw new Error(`${account}'s warm-up starts on ${state.startedOn}`);
    const phase = options.phase ?? warmupPhase(day);
    if (phase === 'done') return { day, phase, goal: 'niche', follows: 0 };
    const follows = between(WARMUP_PLAN.followsPerSession - 1, WARMUP_PLAN.followsPerSession + 1);
    if (phase === 'persona') return { day, phase, goal: 'persona', follows };

    if (searchedOn(await warmupRuns(device.udid, account, state), localDate(now, state.timezone))) return { day, phase, goal: 'niche', follows, noSearchReason: 'already searched today' };
    const query = searchQuery(niche);
    if (!query) return { day, phase, goal: 'niche', follows, noSearchReason: 'the niche has no keywords to search' };
    return {
        day, phase, goal: 'niche', follows,
        // Scroll For You 1-5 min first, then a handful of results.
        search: { query, afterMs: between(60_000, 300_000), videos: between(4, 8) },
    };
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            account: { type: 'string', default: process.env.WARMUP_ACCOUNT },
            minutes: { type: 'string', default: process.env.WARMUP_MINUTES ?? '10' },
            personality: { type: 'string', default: process.env.WARMUP_PERSONALITY ?? 'casual' },
            language: { type: 'string', default: process.env.WARMUP_LANGUAGE ?? 'French' },
            udid: { type: 'string' },
            phase: { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
        },
    });
    if (!values.account) throw new Error('Pass --account @handle (or WARMUP_ACCOUNT)');
    const account = normalizeHandle(values.account);
    const minutes = Number.parseInt(values.minutes, 10);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new Error('--minutes must be 1-60');
    const personality = values.personality as Personality;
    if (!PERSONALITIES.includes(personality)) throw new Error(`--personality must be one of ${PERSONALITIES.join(', ')}`);
    if (values.phase !== undefined && values.phase !== 'persona' && values.phase !== 'niche') throw new Error('--phase must be persona or niche');

    const device = resolveDevice(await loadRegisteredDevices(), values.udid);
    tiktokAdapter.checkAccount!(device, account);
    const state = warmupForAccount(device, account);
    if (!state) throw new Error(`${account} has no warm-up on this device: start one from the device page (TikTok → Warm-up)`);
    const niche = nicheForAccount(device, account);
    if (!niche) throw new Error(`${account} has no niche on this device: save one (device page → Niches)`);

    if (!values.phase && warmupDay(state) < 1) {
        console.log(`[warmup] ${account}'s warm-up starts on ${state.startedOn}; nothing to do yet`);
        return;
    }
    const plan = await planWarmupSession(device, account, state, niche, values.phase ? { phase: values.phase as WarmupPhase } : {});
    assertGoalFits(niche, plan.goal);
    const searchText = plan.search
        ? `search "${plan.search.query}" after ${Math.round(plan.search.afterMs / 1000)} s, ${plan.search.videos} results`
        : plan.noSearchReason ? `no search (${plan.noSearchReason})` : 'no search';
    console.log(`[warmup] ${account} · day ${plan.day} · ${plan.phase} · ${plan.goal === 'persona' ? `persona: ${niche.persona}` : `niche: ${niche.description}`}`);
    console.log(`[warmup] ${minutes} min · ${personality} · ${plan.follows ? `~${plan.follows} follows` : 'no follows'} · ${plan.phase === 'niche' ? searchText : 'no search'} · no comments`);
    if (values['dry-run']) return;

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('Set OPENROUTER_API_KEY in .env');
    const model = process.env.AGENT_MODEL || DEFAULT_AGENT_MODEL;

    let stopping = false;
    const stop = () => {
        stopping = true;
        console.log('[warmup] stopping after this video…');
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    const { session, observation } = await AgentSession.start({
        adapter: tiktokAdapter, minutes, personality, account, udid: device.udid, niche,
        goal: plan.goal, follows: plan.follows, noComments: true,
        ...(plan.search ? { search: plan.search } : {}),
        meta: { warmup: { day: plan.day, phase: plan.phase, startedOn: state.startedOn } },
    });
    const decider = new OpenRouterDecider(apiKey, model, systemPrompt(niche, personality, values.language, 'tiktok', {
        goal: plan.goal, follows: plan.follows > 0, noComments: true,
    }));
    const { summary, error } = await runSession(session, observation, decider, {
        model, shouldStop: () => stopping, log: (line) => console.log(`[warmup] ${line}`),
    });
    const share = `${Math.round(summary.feedOnNicheShare * 100)}% of ${summary.feedVideos} For You videos on-${plan.goal === 'persona' ? 'persona' : 'niche'}`;
    const target = plan.phase === 'niche' ? ` (aim: ~${Math.round(WARMUP_PLAN.targetOnNicheShare * 100)}% by day ${WARMUP_PLAN.personaDays + WARMUP_PLAN.nicheDays})` : '';
    console.log(`[warmup] done: ${share}${target} · ${summary.likes} likes · ${summary.saves} saves · ${summary.follows} follows`
        + `${summary.search ? ` · search "${summary.search.query}": ${summary.search.videos} videos${summary.search.error ? ` (${summary.search.error})` : ''}` : ''}`);
    console.log(`[warmup] summary: ${JSON.stringify(summary)}`);
    if (error) {
        console.error(`[warmup] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
    try {
        await main();
    } catch (error) {
        console.error(`[warmup] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
    process.exit();
}
