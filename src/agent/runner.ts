// Agentic doomscroll (TikTok, Facebook Reels or Instagram Reels) driven by a
// vision model on OpenRouter instead of a Claude Code session. Ads, shop
// posts and non-Reel cards are skipped in code; every other video is judged
// by the model in one stateless call.
//
//   npm run agent:scroll -- [--app tiktok|facebook|instagram] --account @handle --minutes 10 [--personality casual] [--language French] [--udid ...] [--niche "..."] [--swipe-style right-thumb|left-thumb|left-index|right-index|fixed]
//
// TikTok: after the first video or two the session checks the account on the
// Profile tab and switches to --account if the phone is on another one.
// Facebook/Instagram: --account only picks the niche (that app's niche for the
// handle, else its TikTok niche); or pass --niche. They like but never save.
// Facebook and Instagram also comment, rarely (AGENT_COMMENT_CHANCE raises the rate).
//
// --language is the language videos must be in (the phone's language: TikTok
// shows a translation link on anything else); other videos are skipped.
//
// Needs OPENROUTER_API_KEY; AGENT_MODEL overrides the model.

import { parseArgs } from 'node:util';

import { AGENT_APPS, DEFAULT_AGENT_MODEL, OpenRouterDecider, systemPrompt, type AgentApp } from './model.js';
import type { Personality } from '../tiktok/doomscroll-profile.js';
import { SWIPE_STYLES, type SwipeStyle } from '../devices/swipe-profiles.js';
import { AGENT_ADAPTERS } from './adapters.js';
import { runSession } from './loop.js';
import { AgentSession } from './session.js';

const PERSONALITIES: readonly Personality[] = ['skimmer', 'casual', 'engaged'];

const { values } = parseArgs({
    options: {
        app: { type: 'string', default: 'tiktok' },
        account: { type: 'string' },
        minutes: { type: 'string', default: '10' },
        personality: { type: 'string', default: 'casual' },
        udid: { type: 'string' },
        niche: { type: 'string' },
        language: { type: 'string', default: 'French' },
        'swipe-style': { type: 'string' },
    },
});
const swipeStyle = values['swipe-style'] as SwipeStyle | undefined;
if (swipeStyle !== undefined && !(SWIPE_STYLES as readonly string[]).includes(swipeStyle)) {
    throw new Error(`--swipe-style must be one of ${SWIPE_STYLES.join(', ')}`);
}

const app = values.app as AgentApp;
if (!(AGENT_APPS as readonly string[]).includes(app)) throw new Error(`--app must be one of ${AGENT_APPS.join(', ')}`);

const minutes = Number.parseInt(values.minutes, 10);
if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new Error('--minutes must be 1-60');
const personality = values.personality as Personality;
if (!PERSONALITIES.includes(personality)) throw new Error(`--personality must be one of ${PERSONALITIES.join(', ')}`);
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error('Set OPENROUTER_API_KEY in .env');
const model = process.env.AGENT_MODEL || DEFAULT_AGENT_MODEL;

const startOptions = {
    minutes,
    personality,
    ...(values.account ? { account: values.account } : {}),
    ...(values.udid ? { udid: values.udid } : {}),
    ...(values.niche ? { niche: { description: values.niche, keywords: [], avoid: [] } } : {}),
    ...(swipeStyle ? { swipeStyle } : {}),
};
const { session, observation: first } = await AgentSession.start({ ...startOptions, adapter: AGENT_ADAPTERS[app], source: 'runner' });
const decider = new OpenRouterDecider(apiKey, model, systemPrompt(session.niche, personality, values.language, app, { noOcrText: true }));
console.log(`[scroll] ${app} · ${session.account ?? 'current account'} · ${personality} · ${minutes} min · ${model}\n[scroll] niche: ${session.niche.description}${session.niche.avoid.length ? ` · avoid: ${session.niche.avoid.join(', ')}` : ''} · language: ${values.language}`);

let stopping = false;
process.once('SIGINT', () => {
    stopping = true;
    console.log('\n[scroll] stopping after this video…');
});

const { summary, error } = await runSession(session, first, decider, {
    model, shouldStop: () => stopping, log: (line) => console.log(`[scroll] ${line}`),
});
if (error) {
    console.error(`[scroll] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}

console.log(`[scroll] done: ${JSON.stringify(summary)}`);
process.exit();
