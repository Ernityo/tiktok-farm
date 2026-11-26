// Decides one video through a vision model on OpenRouter: one stateless call
// per video (niche + current screenshot + caption), answered with a small JSON
// plan. Faster and cheaper than an interactive Claude Code session because
// nothing accumulates between videos and the model does not reason.

import { z } from 'zod';

import type { AgentPlan } from './agent-plan.js';
import type { Observation } from './agent-session.js';
import type { Personality } from './doomscroll-profile.js';
import type { Niche } from './niche.js';

export const DEFAULT_AGENT_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 8_000;

export function systemPrompt(niche: Niche, personality: Personality, language = 'French'): string {
    return [
        `You scroll a TikTok feed for one account (a ${personality} viewer), teaching its algorithm a niche.`,
        'For each video you get a screenshot, a full-resolution crop of its caption area, and noisy OCR caption text. Reply with JSON only:',
        '{"foreign": true|false, "on_niche": 0..1, "watch": "skip"|"short"|"full", "like": true|false, "save": true|false}',
        `- foreign: true when the video is not in ${language}. A translation link under the caption ("Voir l'original",`,
        `  "Voir la traduction", "See original", "See translation") always means foreign. Foreign videos are skipped.`,
        '- skip: off-niche, ads (AD / Publicité), shop promos (Commission payée), LIVE previews, follow cards.',
        '- short: unsure or loosely related.',
        '- full: clearly on-niche.',
        '- like / save: only on "full" videos. Each video shows likes done vs allowed: when below the allowance, like a',
        '  clearly on-niche video; at the allowance, do not like. Save the same way, standout videos only.',
        'The image wins when it disagrees with the OCR text. Anything matching "avoid" is a skip.',
        `niche: ${niche.description}`,
        niche.keywords.length ? `keywords: ${niche.keywords.join(', ')}` : '',
        niche.avoid.length ? `avoid: ${niche.avoid.join(', ')}` : '',
    ].filter(Boolean).join('\n');
}

/** What the model sees for one video. The caption crop is missing from runs recorded before it existed. */
export type DecisionInput = Pick<Observation, 'video' | 'image' | 'caption' | 'isAd' | 'engagement'> & { captionImage?: Buffer };

export function userText(observation: DecisionInput): string {
    const e = observation.engagement;
    return [
        `video ${observation.video}${observation.isAd ? ' · AD' : ''}`,
        `likes ${e.likes}/${e.likesAllowed} allowed · saves ${e.saves}/${e.savesAllowed} allowed`,
        observation.caption ? `caption (OCR, noisy): ${observation.caption}` : 'caption: (none read)',
    ].join('\n');
}

const Reply = z.object({
    foreign: z.boolean().optional().catch(false),
    on_niche: z.coerce.number().min(0).max(1).catch(0),
    watch: z.enum(['skip', 'short', 'full']),
    like: z.boolean().optional().catch(false),
    save: z.boolean().optional().catch(false),
});

/**
 * Turns the model's reply into a plan; like timings are chosen here, not by
 * the model. A video not in the account's language is always skipped.
 */
export function parseReply(text: string, random: () => number = Math.random): { plan: AgentPlan; foreign: boolean } {
    const json = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const reply = Reply.parse(JSON.parse(json));
    const foreign = reply.foreign === true;
    if (foreign) return { plan: { onNiche: 0, watch: 'skip', likeAtMs: null, save: false }, foreign };
    const engaged = reply.watch === 'full';
    return {
        plan: {
            onNiche: reply.on_niche,
            watch: reply.watch,
            likeAtMs: engaged && reply.like ? Math.round(2000 + random() * 10_000) : null,
            save: engaged && reply.save === true,
        },
        foreign,
    };
}

export interface ModelDecision {
    plan: AgentPlan;
    /** The video is not in the account's language (so the plan is a skip). */
    foreign: boolean;
    ms: number;
    provider?: string;
}

export class OpenRouterDecider {
    constructor(
        private readonly apiKey: string,
        private readonly model: string,
        private readonly system: string,
    ) {}

    async decide(observation: DecisionInput): Promise<ModelDecision> {
        const started = performance.now();
        const response = await fetch(ENDPOINT, {
            method: 'POST',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.model,
                max_tokens: 100,
                temperature: 0.2,
                reasoning: { enabled: false },
                // Route to the provider currently answering fastest.
                provider: { sort: 'latency' },
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: this.system },
                    {
                        role: 'user',
                        content: [
                            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${observation.image.toString('base64')}` } },
                            ...(observation.captionImage
                                ? [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${observation.captionImage.toString('base64')}` } }]
                                : []),
                            { type: 'text', text: userText(observation) },
                        ],
                    },
                ],
            }),
        });
        const body = await response.json() as {
            choices?: Array<{ message?: { content?: string } }>;
            provider?: string;
            error?: { message?: string };
        };
        if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${body.error?.message ?? 'request failed'}`);
        const { plan, foreign } = parseReply(body.choices?.[0]?.message?.content ?? '');
        return { plan, foreign, ms: Math.round(performance.now() - started), ...(body.provider ? { provider: body.provider } : {}) };
    }
}
