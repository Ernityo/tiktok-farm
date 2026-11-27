import assert from 'node:assert/strict';
import test from 'node:test';

import { runSession } from '../src/agent/loop.js';
import type { DecisionInput, ModelDecision, OpenRouterDecider } from '../src/agent/model.js';
import type { AgentPlan } from '../src/agent/plan.js';
import type { AgentSession, Frame, Observation, SessionSummary, StepTrace } from '../src/agent/session.js';

const engagement = { likes: 0, likesAllowed: 1, saves: 0, savesAllowed: 0 };
const summary = { reason: 'completed' } as SessionSummary;

function frame(video: number, tag: string): Frame {
    return { video, image: Buffer.from(tag), captionImage: Buffer.from(`${tag}-caption`), engagement };
}

function observed(of: Frame, extra: Partial<Observation> = {}): Observation {
    return { ...of, caption: `caption ${of.video}`, isAd: false, remainingMs: 60_000, place: 'feed', ...extra };
}

/**
 * A session that, on each step, reports the given frames (as capture does)
 * and then returns the observation; the steps' plans are recorded.
 */
function fakeSession(script: Array<{ frames: Frame[]; observation: (frames: Frame[]) => Observation }>) {
    let listener: ((frame: Frame) => void) | undefined;
    const plans: Array<{ plan: AgentPlan; extra: Record<string, unknown>; trace: StepTrace }> = [];
    let index = 0;
    const session = {
        onFrame(next: ((frame: Frame) => void) | undefined) { listener = next; },
        async step(plan: AgentPlan, extra: Record<string, unknown>, trace: StepTrace) {
            plans.push({ plan, extra, trace });
            const next = script[index++];
            if (!next) return { summary };
            for (const f of next.frames) listener?.(f);
            return { observation: next.observation(next.frames) };
        },
        async stop() { return summary; },
    } as unknown as AgentSession;
    return { session, plans, hasListener: () => listener !== undefined };
}

/** A model that answers "full" with on_niche = the call number, and records what it was shown. */
function fakeDecider() {
    const calls: DecisionInput[] = [];
    const decider = {
        async decide(input: DecisionInput): Promise<ModelDecision> {
            calls.push(input);
            return { plan: { onNiche: calls.length / 10, watch: 'full', likeAtMs: null, save: false }, foreign: false, ms: 5 };
        },
    } as unknown as OpenRouterDecider;
    return { decider, calls };
}

const options = { model: 'm', shouldStop: () => false, log: () => undefined };

test('the model call starts on the frame and its answer is used for that video', async () => {
    const first = frame(1, 'v1');
    const second = frame(2, 'v2');
    const { session, plans, hasListener } = fakeSession([{ frames: [second], observation: ([f]) => observed(f!) }]);
    const { decider, calls } = fakeDecider();

    await runSession(session, observed(first), decider, options);

    // Video 1 had no early call (observed before the loop); video 2's started on its frame: two calls in all.
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.image, second.image);
    assert.equal(calls[1]!.caption, undefined, 'no OCR text for the model');
    assert.equal(plans[1]!.plan.onNiche, 0.2);
    assert.equal(hasListener(), false, 'the listener is removed when the session ends');
});

test('a video the code skips drops the early answer', async () => {
    const ad = frame(2, 'ad');
    const { session, plans } = fakeSession([{ frames: [ad], observation: ([f]) => observed(f!, { isAd: true, autoSkip: 'ad' }) }]);
    const { decider } = fakeDecider();

    await runSession(session, observed(frame(1, 'v1')), decider, options);

    assert.equal(plans[1]!.plan.watch, 'skip');
    assert.deepEqual(plans[1]!.extra, { auto: 'ad' });
});

test('after a retried swipe, the call on the last frame is the one used', async () => {
    const stale = frame(2, 'same-video-again');
    const fresh = frame(2, 'new-video');
    const { session, plans } = fakeSession([{ frames: [stale, fresh], observation: ([, f]) => observed(f!) }]);
    const { decider, calls } = fakeDecider();

    await runSession(session, observed(frame(1, 'v1')), decider, options);

    assert.equal(calls.length, 3);
    assert.equal(calls[2]!.image, fresh.image);
    assert.equal(plans[1]!.plan.onNiche, 0.3, 'the answer for the fresh frame');
});

test('the model call is timed and its start and end reach the step', async () => {
    const { session, plans } = fakeSession([{ frames: [frame(2, 'v2')], observation: ([f]) => observed(f!) }]);
    const { decider } = fakeDecider();

    await runSession(session, observed(frame(1, 'v1')), decider, options);

    const model = plans[1]!.trace.model!;
    assert.ok(model.start <= model.end);
    assert.deepEqual(plans[2] ? plans[2].trace : {}, {}, 'no trace on the closing step without a call');
});

test('AGENT_EARLY_DECIDE=0 waits for the observation before calling the model', async () => {
    process.env.AGENT_EARLY_DECIDE = '0';
    try {
        const second = frame(2, 'v2');
        const { session, hasListener } = fakeSession([{ frames: [second], observation: ([f]) => observed(f!, { caption: 'seen' }) }]);
        let listenerDuringRun = true;
        const { decider, calls } = fakeDecider();
        const original = session.step.bind(session);
        session.step = (async (...args: Parameters<AgentSession['step']>) => {
            listenerDuringRun &&= hasListener();
            return original(...args);
        }) as AgentSession['step'];

        await runSession(session, observed(frame(1, 'v1')), decider, options);

        assert.equal(listenerDuringRun, false, 'no frame listener');
        assert.equal(calls.length, 2);
        assert.equal(calls[1]!.image, second.image, 'video 2 judged from its observation');
    } finally {
        delete process.env.AGENT_EARLY_DECIDE;
    }
});
