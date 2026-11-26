// Must stay the first import: it moves stray stdout logging to stderr.
import { protocolStdout } from './stdout-guard.js';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { TikTokAgentSession, type Observation, type SessionSummary } from './agent-session.js';
import { PROFILES, type Personality } from './doomscroll-profile.js';
import type { Niche } from './niche.js';
import { SWIPE_STYLES } from '../devices/swipe-profiles.js';

// MCP server for agentic TikTok doomscroll, driven from an interactive Claude
// Code session (registered in .mcp.json). The agent sees one small screenshot
// per video and answers with a plan; the session carries it out. One tool
// call per video keeps latency and tokens low.

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

let session: TikTokAgentSession | undefined;

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
    return `likes ${e.likes}/${e.likesAllowed} allowed${likeHint} · saves ${e.saves}/${e.savesAllowed} allowed`;
}

function nicheText(niche: Niche): string {
    return [
        `niche: ${niche.description}`,
        niche.keywords.length ? `keywords: ${niche.keywords.join(', ')}` : '',
        niche.avoid.length ? `avoid: ${niche.avoid.join(', ')}` : '',
    ].filter(Boolean).join('\n');
}

function personalityText(personality: Personality): string {
    const { likeChance, saveChance } = PROFILES[personality];
    const percent = (value: number) => `${Math.round(value * 100)}%`;
    return `${personality} viewer: like ~${percent(likeChance)} and save ~${percent(saveChance)} of all videos (extra likes/saves are dropped)`;
}

function summaryText(summary: SessionSummary): string {
    return `Session ${summary.reason}. ${JSON.stringify(summary)}`;
}

function failure(error: unknown) {
    return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] };
}

const server = new McpServer({ name: 'tiktok-agent', version: '0.1.0' });

server.registerTool('tiktok_start', {
    title: 'Start agentic TikTok doomscroll',
    description: 'Unlocks the phone, opens TikTok (already on the account) and returns the niche plus the first video. '
        + 'Then call tiktok_step once per video until it reports the session is over.',
    inputSchema: {
        minutes: z.number().int().min(1).max(60).describe('Session length in minutes'),
        personality: z.enum(['skimmer', 'casual', 'engaged']).default('casual')
            .describe('Viewer type: caps likes/saves and sets watch lengths (default casual)'),
        account: z.string().optional().describe('TikTok handle the phone is already on, e.g. @fitjulie; its saved niche is used (no switching)'),
        niche: z.string().max(1000).optional().describe('Niche description; overrides the saved one'),
        udid: z.string().optional().describe('Device UDID; only needed when several phones are registered'),
        swipeStyle: z.enum(SWIPE_STYLES).optional()
            .describe('Thumb side the swipes copy: right-thumb (default), left-thumb, left-index, right-index, or fixed for the old straight swipe'),
    },
}, async ({ minutes, personality, account, niche, udid, swipeStyle }) => {
    if (session) return failure('A session is already running; call tiktok_stop first');
    try {
        const started = await TikTokAgentSession.start({
            minutes,
            personality,
            ...(account ? { account } : {}),
            ...(udid ? { udid } : {}),
            ...(swipeStyle ? { swipeStyle } : {}),
            ...(niche ? { niche: { description: niche, keywords: [], avoid: [] } } : {}),
        });
        session = started.session;
        return {
            content: [
                {
                    type: 'text' as const,
                    text: `${started.session.account ?? 'current account'} · ${personalityText(started.session.personality)}\n${nicheText(started.session.niche)}`,
                },
                ...observationContent(started.observation),
            ],
        };
    } catch (error) {
        return failure(error);
    }
});

server.registerTool('tiktok_step', {
    title: 'Act on the current TikTok video',
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
        save: z.boolean().optional().describe('Bookmark the video'),
    },
}, async ({ on_niche, watch, like_at_ms, save }) => {
    if (!session) return failure('No session running; call tiktok_start first');
    try {
        const result = await session.step({ onNiche: on_niche, watch, likeAtMs: like_at_ms ?? null, save: save ?? false });
        if ('summary' in result) {
            session = undefined;
            return { content: [{ type: 'text' as const, text: summaryText(result.summary) }] };
        }
        return { content: observationContent(result.observation) };
    } catch (error) {
        return failure(error);
    }
});

server.registerTool('tiktok_stop', {
    title: 'Stop agentic TikTok doomscroll',
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
console.error('[agent] tiktok-agent MCP server ready');
