// The decide → step loop shared by the CLI runner and the scheduled warm-up:
// every video is judged by the model in one stateless call (or skipped in
// code), then carried out by the session. The call starts as soon as the
// frame is captured, while the session OCRs the caption and runs its checks;
// when those skip the video, the model's answer is dropped. So the model gets
// the images only, no OCR text: build its prompt with `noOcrText`.

import type { DecisionInput, ModelDecision, OpenRouterDecider } from './model.js';
import type { AgentPlan } from './plan.js';
import type { AgentSession, Frame, Observation, SessionSummary } from './session.js';

/** Consecutive model failures before the session is stopped. */
const MAX_MODEL_FAILURES = 3;

const SKIP: AgentPlan = { onNiche: 0, watch: 'skip', likeAtMs: null, save: false };

/** The model's input: screenshot, caption crop and counts; no OCR text or ad flag (ads are skipped in code). */
function modelInput({ video, image, captionImage, engagement }: Frame): DecisionInput {
    return { video, image, captionImage, engagement, isAd: false };
}

async function decide(decider: OpenRouterDecider, observation: DecisionInput, log: (line: string) => void): Promise<ModelDecision> {
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
    // The call started on the latest frame, if any (a retried swipe replaces it).
    let early: { image: Buffer; decision: Promise<ModelDecision> } | undefined;
    session.onFrame((frame) => {
        const decision = decide(decider, modelInput(frame), log);
        decision.catch(() => undefined); // dropped when the video is skipped in code
        early = { image: frame.image, decision };
    });
    try {
        for (;;) {
            if (shouldStop()) return { summary: await session.stop('stopped') };
            const skipReason = observation.autoSkip;
            const started = early?.image === observation.image ? early.decision : undefined;
            early = undefined;
            let plan: AgentPlan;
            let extra: Record<string, unknown>;
            if (skipReason) {
                plan = SKIP;
                extra = { auto: skipReason };
            } else {
                try {
                    const decision = await (started ?? decide(decider, modelInput(observation), log));
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
    } finally {
        session.onFrame(undefined);
    }
}
