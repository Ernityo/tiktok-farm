// The decide → step loop shared by the CLI runner and the scheduled warm-up:
// every video is judged by the model in one stateless call (or skipped in
// code), then carried out by the session.

import type { ModelDecision, OpenRouterDecider } from './model.js';
import type { AgentPlan } from './plan.js';
import type { AgentSession, Observation, SessionSummary } from './session.js';

/** Consecutive model failures before the session is stopped. */
const MAX_MODEL_FAILURES = 3;

const SKIP: AgentPlan = { onNiche: 0, watch: 'skip', likeAtMs: null, save: false };

async function decide(decider: OpenRouterDecider, observation: Observation, log: (line: string) => void): Promise<ModelDecision> {
    try {
        return await decider.decide(observation);
    } catch (first) {
        log(`model call failed, retrying: ${first instanceof Error ? first.message : String(first)}`);
        return decider.decide(observation);
    }
}

export function describePlan(plan: AgentPlan): string {
    return `${plan.watch.padEnd(5)} ${plan.onNiche.toFixed(2)}${plan.likeAtMs ? ' like' : ''}${plan.save ? ' save' : ''}`
        + `${plan.follow ? ' follow' : ''}${plan.comment ? ` comment ${JSON.stringify(plan.comment)}` : ''}`;
}

/**
 * Runs the session to its end (or until `shouldStop` turns true, checked
 * between videos). Never throws: an error stops the session and is returned
 * with its summary.
 */
export async function runSession(
    session: AgentSession,
    first: Observation,
    decider: OpenRouterDecider,
    { model, shouldStop, log }: { model: string; shouldStop: () => boolean; log: (line: string) => void },
): Promise<{ summary: SessionSummary; error?: unknown }> {
    let observation = first;
    let failures = 0;
    try {
        for (;;) {
            if (shouldStop()) return { summary: await session.stop('stopped') };
            const skipReason = observation.autoSkip;
            let plan: AgentPlan;
            let extra: Record<string, unknown>;
            if (skipReason) {
                plan = SKIP;
                extra = { auto: skipReason };
            } else {
                try {
                    const decision = await decide(decider, observation, log);
                    failures = 0;
                    plan = decision.plan;
                    extra = { model, modelMs: decision.ms, provider: decision.provider, ...(decision.foreign ? { foreign: true } : {}) };
                } catch (error) {
                    failures += 1;
                    if (failures >= MAX_MODEL_FAILURES) throw error;
                    log(`model failed twice, skipping this video: ${error instanceof Error ? error.message : String(error)}`);
                    plan = SKIP;
                    extra = { auto: 'model-error' };
                }
            }
            const where = observation.place === 'search' ? ' [search]' : '';
            log(`#${String(observation.video).padStart(3)}${where} ${describePlan(plan)}  ${skipReason ? `(auto: ${skipReason})` : `(${String(extra.modelMs)} ms${extra.foreign ? ', not in language' : ''})`}  ${observation.caption.slice(0, 70)}`);
            const result = await session.step(plan, extra);
            if ('summary' in result) return { summary: result.summary };
            observation = result.observation;
        }
    } catch (error) {
        return { summary: await session.stop('error'), error };
    }
}
