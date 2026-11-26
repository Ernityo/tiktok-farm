// Agentic TikTok doomscroll driven by a vision model on OpenRouter instead of
// a Claude Code session. Ads and shop posts are skipped in code; every other
// video is judged by the model in one stateless call.
//
//   npm run agent:scroll -- --account @handle --minutes 10 [--personality casual] [--language French] [--udid ...] [--niche "..."] [--swipe-style right-thumb|left-thumb|left-index|right-index|fixed]
//
// --language is the language videos must be in (the phone's language: TikTok
// shows a translation link on anything else); other videos are skipped.
//
// Needs OPENROUTER_API_KEY; AGENT_MODEL overrides the model.

import { parseArgs } from 'node:util';

import { DEFAULT_AGENT_MODEL, OpenRouterDecider, systemPrompt, type ModelDecision } from './agent-model.js';
import { autoSkipReason, type AgentPlan } from './agent-plan.js';
import { TikTokAgentSession, type Observation, type SessionSummary } from './agent-session.js';
import type { Personality } from './doomscroll-profile.js';
import { SWIPE_STYLES, type SwipeStyle } from '../devices/swipe-profiles.js';

const PERSONALITIES: readonly Personality[] = ['skimmer', 'casual', 'engaged'];
/** Consecutive model failures before the session is stopped. */
const MAX_MODEL_FAILURES = 3;

const { values } = parseArgs({
    options: {
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

const minutes = Number.parseInt(values.minutes, 10);
if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new Error('--minutes must be 1-60');
const personality = values.personality as Personality;
if (!PERSONALITIES.includes(personality)) throw new Error(`--personality must be one of ${PERSONALITIES.join(', ')}`);
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error('Set OPENROUTER_API_KEY in .env');
const model = process.env.AGENT_MODEL || DEFAULT_AGENT_MODEL;

async function decide(decider: OpenRouterDecider, observation: Observation): Promise<ModelDecision> {
    try {
        return await decider.decide(observation);
    } catch (first) {
        console.log(`[scroll] model call failed, retrying: ${first instanceof Error ? first.message : String(first)}`);
        return decider.decide(observation);
    }
}

function describe(plan: AgentPlan): string {
    return `${plan.watch.padEnd(5)} ${plan.onNiche.toFixed(2)}${plan.likeAtMs ? ' like' : ''}${plan.save ? ' save' : ''}`;
}

const { session, observation: first } = await TikTokAgentSession.start({
    minutes,
    personality,
    ...(values.account ? { account: values.account } : {}),
    ...(values.udid ? { udid: values.udid } : {}),
    ...(values.niche ? { niche: { description: values.niche, keywords: [], avoid: [] } } : {}),
    ...(swipeStyle ? { swipeStyle } : {}),
});
const decider = new OpenRouterDecider(apiKey, model, systemPrompt(session.niche, personality, values.language));
console.log(`[scroll] ${session.account ?? 'current account'} · ${personality} · ${minutes} min · ${model}\n[scroll] niche: ${session.niche.description}${session.niche.avoid.length ? ` · avoid: ${session.niche.avoid.join(', ')}` : ''} · language: ${values.language}`);

let stopping = false;
process.once('SIGINT', () => {
    stopping = true;
    console.log('\n[scroll] stopping after this video…');
});

let observation: Observation = first;
let failures = 0;
let summary: SessionSummary | undefined;
try {
    while (!summary) {
        if (stopping) {
            summary = await session.stop('stopped');
            break;
        }
        const skipReason = autoSkipReason(observation);
        let plan: AgentPlan;
        let extra: Record<string, unknown>;
        if (skipReason) {
            plan = { onNiche: 0, watch: 'skip', likeAtMs: null, save: false };
            extra = { auto: skipReason };
        } else {
            try {
                const decision = await decide(decider, observation);
                failures = 0;
                plan = decision.plan;
                extra = { model, modelMs: decision.ms, provider: decision.provider, ...(decision.foreign ? { foreign: true } : {}) };
            } catch (error) {
                failures += 1;
                if (failures >= MAX_MODEL_FAILURES) throw error;
                console.log(`[scroll] model failed twice, skipping this video: ${error instanceof Error ? error.message : String(error)}`);
                plan = { onNiche: 0, watch: 'skip', likeAtMs: null, save: false };
                extra = { auto: 'model-error' };
            }
        }
        console.log(`[scroll] #${String(observation.video).padStart(3)} ${describe(plan)}  ${skipReason ? `(auto: ${skipReason})` : `(${String(extra.modelMs)} ms${extra.foreign ? ', not in language' : ''})`}  ${observation.caption.slice(0, 70)}`);
        const result = await session.step(plan, extra);
        if ('summary' in result) summary = result.summary;
        else observation = result.observation;
    }
} catch (error) {
    summary = await session.stop('error');
    console.error(`[scroll] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}

console.log(`[scroll] done: ${JSON.stringify(summary)}`);
process.exit();
