// Decides one video through a vision model on OpenRouter: one stateless call
// per video (niche + current screenshot + caption), answered with a small JSON
// plan. Faster and cheaper than an interactive Claude Code session because
// nothing accumulates between videos and the model does not reason.

import { z } from 'zod';

import type { AgentPlan } from './plan.js';
import type { Observation } from './session.js';
import type { Personality } from '../tiktok/doomscroll-profile.js';
import type { Niche } from '../tiktok/niche.js';

export const DEFAULT_AGENT_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 8_000;

/** Apps the agentic doomscroll can drive. */
export const AGENT_APPS = ['tiktok', 'facebook', 'instagram'] as const;
export type AgentApp = (typeof AGENT_APPS)[number];

/** Per-app wording of the prompt. Only TikTok can save from the feed. */
const APP_PROMPTS: Record<AgentApp, { feed: string; canSave: boolean; canComment: boolean; foreign: (language: string) => string[]; skip: string }> = {
    tiktok: {
        feed: 'TikTok feed',
        canSave: true,
        canComment: false,
        foreign: (language) => [
            `- foreign: true when the video is not in ${language}. A translation link under the caption ("Voir l'original",`,
            `  "Voir la traduction", "See original", "See translation") always means foreign. Foreign videos are skipped.`,
        ],
        skip: '- skip: off-niche, ads (AD / Publicité), shop promos (Commission payée), LIVE previews, follow cards.',
    },
    facebook: {
        feed: 'Facebook Reels feed',
        canSave: false,
        canComment: true,
        foreign: (language) => [
            `- foreign: true when the video is not in ${language}. A translation link under the caption ("Afficher l'original",`,
            `  "Voir la traduction", "See original", "See translation") always means foreign. Foreign videos are skipped.`,
        ],
        skip: '- skip: off-niche, ads (Sponsorisé / Sponsored), shop links, LIVE previews, suggestion cards.',
    },
    instagram: {
        feed: 'Instagram Reels feed',
        canSave: false,
        canComment: true,
        foreign: (language) => [
            `- foreign: true when the video is not in ${language}. A translation link under the caption ("Voir la traduction",`,
            `  "See translation") always means foreign. Foreign videos are skipped.`,
        ],
        skip: '- skip: off-niche, ads (Sponsorisé(e) / Sponsored), shop links, suggestion and survey cards, Threads posts.',
    },
};

/** How the account comments: who it is and how it texts. */
export function commentRules(niche: Niche, language: string): string[] {
    return [
        '- comment: null almost always. Only on a "full" video, and only when the video shows comments done vs allowed with',
        '  some left (no comments line: null). Then write one comment as this person:',
        `  ${niche.persona ?? 'a regular person scrolling on their phone'}.`,
        `  Write it the way she would text a friend in ${language}: all lowercase, no punctuation at all, no emojis, 2 to 10 words,`,
        '  casual and real, texting shortcuts are fine sometimes. React to something specific happening in this video.',
        '  Not polite, not enthusiastic-marketing, no "merci pour le partage", nothing generic ("super video", "trop bien"),',
        '  no questions to the creator, no hashtags, no mentions, no links.',
    ];
}

/**
 * What a session teaches the feed: the account's niche, or (first warm-up
 * phase) who the person is, from the niche's persona.
 */
export type ScrollGoal = 'niche' | 'persona';

export interface PromptOptions {
    goal?: ScrollGoal;
    /** The session follows creators (warm-up): the reply gets a "follow" field. */
    follows?: boolean;
    /** Never ask for comments, even on apps that can comment (warm-up). */
    noComments?: boolean;
    /** The model gets no OCR caption text, only the screenshot and the caption crop (the code still reads it, in parallel). */
    noOcrText?: boolean;
}

/** Throws when the niche can't drive a session with this goal. */
export function assertGoalFits(niche: Niche, goal: ScrollGoal): void {
    if (goal === 'persona' && !niche.persona) {
        throw new Error('The persona warm-up phase needs a persona: add one to the account\'s niche (device page → Niches)');
    }
}

export function systemPrompt(
    niche: Niche, personality: Personality, language = 'French', app: AgentApp = 'tiktok', options: PromptOptions = {},
): string {
    const wording = APP_PROMPTS[app];
    const goal = options.goal ?? 'niche';
    assertGoalFits(niche, goal);
    const canComment = wording.canComment && !options.noComments;
    const fields = [
        '"foreign": true|false, "on_niche": 0..1, "watch": "skip"|"short"|"full", "like": true|false',
        ...(wording.canSave ? ['"save": true|false'] : []),
        ...(options.follows ? ['"follow": true|false'] : []),
        ...(canComment ? ['"comment": "text"|null'] : []),
    ];
    const teaching = goal === 'persona'
        ? 'teaching its algorithm who this person is: the everyday things they would genuinely enjoy watching'
        : 'teaching its algorithm a niche';
    const target = goal === 'persona'
        ? [
            'niche (for now): whatever this person would enjoy day to day. Judge loosely: a real person has several broad',
            `interests (their age, job, city, hobbies, humour, food...), not one topic. The person: ${niche.persona}`,
        ]
        : [
            `niche: ${niche.description}`,
            niche.keywords.length ? `keywords: ${niche.keywords.join(', ')}` : '',
        ];
    return [
        `You scroll a ${wording.feed} for one account (a ${personality} viewer), ${teaching}.`,
        options.noOcrText
            ? 'For each video you get a screenshot and a full-resolution crop of its caption area. Reply with JSON only:'
            : 'For each video you get a screenshot, a full-resolution crop of its caption area, and noisy OCR caption text. Reply with JSON only:',
        `{${fields.join(', ')}}`,
        ...wording.foreign(language),
        wording.skip,
        '- short: unsure or loosely related.',
        '- full: clearly on-niche.',
        ...(wording.canSave
            ? [
                '- like / save: only on "full" videos. Each video shows likes done vs allowed: when below the allowance, like a',
                '  clearly on-niche video; at the allowance, do not like. Save the same way, standout videos only.',
            ]
            : [
                '- like: only on "full" videos. Each video shows likes done vs allowed: when below the allowance, like a',
                '  clearly on-niche video; at the allowance, do not like.',
            ]),
        ...(options.follows
            ? [
                '- follow: only on a "full" video, and only when the video shows follows done vs allowed with some left',
                '  (no follows line: false). Then true when the creator clearly posts this kind of video, someone this',
                '  account would follow. Never follow ads, shops or brands.',
            ]
            : []),
        ...(canComment ? commentRules(niche, language) : []),
        'The image wins when it disagrees with the OCR text. Anything matching "avoid" is a skip.',
        ...target,
        niche.avoid.length ? `avoid: ${niche.avoid.join(', ')}` : '',
    ].filter(Boolean).join('\n');
}

/** What the model sees for one video. The caption crop is missing from runs recorded before it existed. */
/** Without `caption` (OCR text not read yet) the caption line is left out. */
export type DecisionInput = Pick<Observation, 'video' | 'image' | 'isAd' | 'engagement'> & { caption?: string; captionImage?: Buffer };

export function userText(observation: DecisionInput): string {
    const e = observation.engagement;
    return [
        `video ${observation.video}${observation.isAd ? ' · AD' : ''}`,
        [
            `likes ${e.likes}/${e.likesAllowed} allowed`,
            ...(e.savesAllowed > 0 ? [`saves ${e.saves}/${e.savesAllowed} allowed`] : []),
            // Only shown while one is left, so the model isn't tempted otherwise.
            ...((e.commentsAllowed ?? 0) > (e.comments ?? 0) ? [`comments ${e.comments ?? 0}/${e.commentsAllowed} allowed`] : []),
            ...((e.followsAllowed ?? 0) > (e.follows ?? 0) ? [`follows ${e.follows ?? 0}/${e.followsAllowed} allowed`] : []),
        ].join(' · '),
        ...(observation.caption === undefined ? [] : [observation.caption ? `caption (OCR, noisy): ${observation.caption}` : 'caption: (none read)']),
    ].join('\n');
}

const Reply = z.object({
    foreign: z.boolean().optional().catch(false),
    on_niche: z.coerce.number().min(0).max(1).catch(0),
    watch: z.enum(['skip', 'short', 'full']),
    like: z.boolean().optional().catch(false),
    save: z.boolean().optional().catch(false),
    comment: z.string().nullable().optional().catch(null),
    follow: z.boolean().optional().catch(false),
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
            ...(engaged && reply.comment ? { comment: reply.comment } : {}),
            ...(engaged && reply.follow === true ? { follow: true } : {}),
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
                // Room for a short comment on top of the plan.
                max_tokens: 160,
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
