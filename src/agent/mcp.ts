// Must stay the first import: it moves stray stdout logging to stderr.
import { protocolStdout } from './stdout-guard.js';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { AGENT_ADAPTERS } from './adapters.js';
import { AgentSession, type Observation, type SessionSummary } from './session.js';
import { AGENT_APPS, type AgentApp } from './model.js';
import type { AgentPlan } from './plan.js';
import { PROFILES, type Personality } from '../tiktok/doomscroll-profile.js';
import type { Niche } from '../tiktok/niche.js';
import { SWIPE_STYLES } from '../devices/swipe-profiles.js';

// MCP server for agentic doomscroll (TikTok, Facebook Reels or Instagram
// Reels), driven from an interactive Claude Code session (registered in
// .mcp.json). The agent sees one small screenshot per video and answers with
// a plan; the session carries it out. One tool call per video keeps latency
// and tokens low. Ads, shop posts and cards are skipped here without asking
// the agent, like the OpenRouter runner does.

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

let session: AgentSession | undefined;

const SKIP: AgentPlan = { onNiche: 0, watch: 'skip', likeAtMs: null, save: false };

function formatRemaining(ms: number): string {
    const seconds = Math.round(ms / 1000);
    return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function observationContent(observation: Observation): Content[] {
    const caption = observation.caption ? `caption (OCR, noisy): ${observation.caption}` : 'caption: (none read)';
    return [
        { type: 'image', data: observation.image.toString('base64'), mimeType: 'image/jpeg' },
        { type: 'text', text: `video ${observation.video} · ${formatRemaining(observation.remainingMs)} left${observation.isAd ? ' · AD' : ''}\n${engagementText(observation)}\n${caption}` },
    ];
}

function engagementText({ engagement: e }: Observation): string {
    const likeHint = e.likes < e.likesAllowed ? ' → behind: like this one if it is clearly on-niche' : '';
    const saves = session?.app === 'tiktok' ? ` · saves ${e.saves}/${e.savesAllowed} allowed` : '';
    return `likes ${e.likes}/${e.likesAllowed} allowed${likeHint}${saves}`;
}

/** Steps past videos the session already knows to skip; returns the next one to judge, or the summary. */
async function skipAutomatic(
    current: AgentSession, result: { observation: Observation } | { summary: SessionSummary },
): Promise<{ observation: Observation } | { summary: SessionSummary }> {
    while ('observation' in result && result.observation.autoSkip) {
        console.error(`[agent] #${result.observation.video} auto-skip: ${result.observation.autoSkip}`);
        result = await current.step(SKIP, { auto: result.observation.autoSkip });
    }
    return result;
}

function nicheText(niche: Niche): string {
    return [
        `niche: ${niche.description}`,
        niche.keywords.length ? `keywords: ${niche.keywords.join(', ')}` : '',
        niche.avoid.length ? `avoid: ${niche.avoid.join(', ')}` : '',
    ].filter(Boolean).join('\n');
}

function personalityText(personality: Personality, app: AgentApp): string {
    const { likeChance, saveChance } = PROFILES[personality];
    const percent = (value: number) => `${Math.round(value * 100)}%`;
    if (app !== 'tiktok') return `${personality} viewer: like ~${percent(likeChance)} of all videos (extra likes are dropped; no saves on ${app})`;
    return `${personality} viewer: like ~${percent(likeChance)} and save ~${percent(saveChance)} of all videos (extra likes/saves are dropped)`;
}

function summaryText(summary: SessionSummary): string {
    return `Session ${summary.reason}. ${JSON.stringify(summary)}`;
}

function failure(error: unknown) {
    return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] };
}

const server = new McpServer({ name: 'doomscroll-agent', version: '0.1.0' });

server.registerTool('doomscroll_start', {
    title: 'Start agentic doomscroll',
    description: 'Unlocks the phone, opens TikTok, Facebook Reels or Instagram Reels (already on the account) and returns the niche plus the first video. '
        + 'Ads, shop posts and cards are skipped without you. Then call doomscroll_step once per video until it reports the session is over.',
    inputSchema: {
        app: z.enum(AGENT_APPS).default('tiktok').describe('Which feed to scroll (default tiktok). Facebook and Instagram like but never save'),
        minutes: z.number().int().min(1).max(60).describe('Session length in minutes'),
        personality: z.enum(['skimmer', 'casual', 'engaged']).default('casual')
            .describe('Viewer type: caps likes/saves and sets watch lengths (default casual)'),
        account: z.string().optional().describe('Handle the phone is already on, e.g. @fitjulie; its saved niche is used (no switching). '
            + 'On Facebook/Instagram it only picks the niche (that app\'s niche for the handle, else its TikTok one)'),
        niche: z.string().max(1000).optional().describe('Niche description; overrides the saved one'),
        udid: z.string().optional().describe('Device UDID; only needed when several phones are registered'),
        swipeStyle: z.enum(SWIPE_STYLES).optional()
            .describe('Thumb side the swipes copy: right-thumb (default), left-thumb, left-index, right-index, or fixed for the old straight swipe'),
    },
}, async ({ app, minutes, personality, account, niche, udid, swipeStyle }) => {
    if (session) return failure('A session is already running; call doomscroll_stop first');
    try {
        const started = await AgentSession.start({
            adapter: AGENT_ADAPTERS[app],
            minutes,
            personality,
            ...(account ? { account } : {}),
            ...(udid ? { udid } : {}),
            ...(swipeStyle ? { swipeStyle } : {}),
            ...(niche ? { niche: { description: niche, keywords: [], avoid: [] } } : {}),
        });
        session = started.session;
        const first = await skipAutomatic(started.session, { observation: started.observation });
        if ('summary' in first) {
            session = undefined;
            return { content: [{ type: 'text' as const, text: summaryText(first.summary) }] };
        }
        return {
            content: [
                {
                    type: 'text' as const,
                    text: `${app} · ${started.session.account ?? 'current account'} · ${personalityText(started.session.personality, app)}\n${nicheText(started.session.niche)}`,
                },
                ...observationContent(first.observation),
            ],
        };
    } catch (error) {
        return failure(error);
    }
});

server.registerTool('doomscroll_step', {
    title: 'Act on the current video',
    description: 'Carries out your plan for the video on screen, swipes, and returns the next video. '
        + 'Decide fast and call this right away with no commentary: while you think the video keeps playing, '
        + 'so slow decisions make off-niche videos look watched. '
        + 'Off-niche or ad: watch "skip", no like/save. Unsure: "short". Clearly on-niche: "full". '
        + 'Each video shows likes done vs allowed so far: when likes are below the allowance, like the next clearly on-niche "full" video; '
        + 'at the allowance, do not like. Save rarely, standout videos only. Vary like_at_ms (2000-12000). '
        + 'Watch time is the main niche signal, likes come second. The code adds randomness and drops likes/saves over the rate.',
    inputSchema: {
        on_niche: z.number().min(0).max(1).describe('How sure you are the video is on-niche'),
        watch: z.enum(['skip', 'short', 'full']).describe('skip = swipe now; short = a few seconds; full = watch to the end'),
        like_at_ms: z.number().int().min(0).max(30000).nullable().optional().describe('When to like, ms from now; null = no like'),
        save: z.boolean().optional().describe('Bookmark the video (TikTok only; ignored on Facebook/Instagram)'),
    },
}, async ({ on_niche, watch, like_at_ms, save }) => {
    if (!session) return failure('No session running; call doomscroll_start first');
    try {
        const result = await skipAutomatic(session, await session.step({ onNiche: on_niche, watch, likeAtMs: like_at_ms ?? null, save: save ?? false }));
        if ('summary' in result) {
            session = undefined;
            return { content: [{ type: 'text' as const, text: summaryText(result.summary) }] };
        }
        return { content: observationContent(result.observation) };
    } catch (error) {
        return failure(error);
    }
});

server.registerTool('doomscroll_stop', {
    title: 'Stop agentic doomscroll',
    description: 'Ends the running session early and returns its summary.',
    inputSchema: {},
}, async () => {
    if (!session) return failure('No session running');
    const summary = await session.stop('stopped');
    session = undefined;
    return { content: [{ type: 'text' as const, text: summaryText(summary) }] };
});

async function shutdown(): Promise<void> {
    const running = session;
    session = undefined;
    await running?.stop('stopped').catch(() => undefined);
    process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

const transport = new StdioServerTransport(process.stdin, protocolStdout);
transport.onclose = () => void shutdown();
// Claude Code exiting closes our stdin: release the phone.
process.stdin.on('end', () => void shutdown());
await server.connect(transport);
console.error('[agent] doomscroll-agent MCP server ready');
