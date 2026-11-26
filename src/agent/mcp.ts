// Must stay the first import: it moves stray stdout logging to stderr.
import { protocolStdout } from './stdout-guard.js';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { AGENT_ADAPTERS } from './adapters.js';
import { AgentSession, connectApp, resolveDevice, type Observation, type SessionSummary } from './session.js';
import { AppStuckError, MAX_COMMENT_LENGTH, sanitizeComment } from './comment.js';
import { leaveComment, type CommentSheetSpec } from './comment-flow.js';
import { FACEBOOK_COMMENT_SHEET } from '../facebook/comment.js';
import { INSTAGRAM_COMMENT_SHEET } from '../instagram/comment.js';

const COMMENT_SHEETS: Record<'facebook' | 'instagram', CommentSheetSpec> = { facebook: FACEBOOK_COMMENT_SHEET, instagram: INSTAGRAM_COMMENT_SHEET };
import { AGENT_APPS, type AgentApp } from './model.js';
import type { AgentPlan } from './plan.js';
import { PROFILES, type Personality } from '../tiktok/doomscroll-profile.js';
import type { Niche } from '../tiktok/niche.js';
import { SWIPE_STYLES } from '../devices/swipe-profiles.js';
import { loadRegisteredDevices } from '../devices/registry.js';
import { RegistryWdaRemoteControl } from '../devices/registry-remote.js';
import { emitTouch } from '../devices/touch-events.js';
import { MAX_TYPING_LENGTH } from '../devices/typing.js';
import { closeExplore, exploreContext, look, swipe, tap } from './explore.js';

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
    const comments = (e.commentsAllowed ?? 0) > (e.comments ?? 0) ? ` · comments ${e.comments ?? 0}/${e.commentsAllowed} allowed` : '';
    return `likes ${e.likes}/${e.likesAllowed} allowed${likeHint}${saves}${comments}`;
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
        niche.persona ? `persona (voice of comments): ${niche.persona}` : '',
    ].filter(Boolean).join('\n');
}

function personalityText(personality: Personality, app: AgentApp): string {
    const { likeChance, saveChance } = PROFILES[personality];
    const percent = (value: number) => `${Math.round(value * 100)}%`;
    if (app !== 'tiktok') {
        return `${personality} viewer: like ~${percent(likeChance)} of all videos (extra likes are dropped; no saves on ${app}). `
            + 'Comment only when a video shows a "comments N/M allowed" line, rarely, on a clearly on-niche full watch';
    }
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
    description: 'Unlocks the phone, opens TikTok, Facebook Reels or Instagram Reels and returns the niche plus the first video. On TikTok the account is checked after the first video or two '
        + '(Profile tab) and switched to if needed; nothing is liked or saved before that. On Facebook/Instagram the phone must already be on the account. '
        + 'Ads, shop posts and cards are skipped without you. Then call doomscroll_step once per video until it reports the session is over.',
    inputSchema: {
        app: z.enum(AGENT_APPS).default('tiktok').describe('Which feed to scroll (default tiktok). Facebook and Instagram like but never save'),
        minutes: z.number().int().min(1).max(60).describe('Session length in minutes'),
        personality: z.enum(['skimmer', 'casual', 'engaged']).default('casual')
            .describe('Viewer type: caps likes/saves and sets watch lengths (default casual)'),
        account: z.string().optional().describe('Account handle, e.g. @fitjulie; its saved niche is used. On TikTok the session switches to it if the phone is on another account. '
            + 'On Facebook/Instagram it only picks the niche (that app\'s niche for the handle, else its TikTok one)'),
        niche: z.string().max(1000).optional().describe('Niche description; overrides the saved one'),
        udid: z.string().optional().describe('Device UDID; only needed when several phones are registered'),
        swipeStyle: z.enum(SWIPE_STYLES).optional()
            .describe('Thumb side the swipes copy: right-thumb (default), left-thumb, left-index, right-index, or fixed for the old straight swipe'),
    },
}, async ({ app, minutes, personality, account, niche, udid, swipeStyle }) => {
    if (session) return failure('A session is already running; call doomscroll_stop first');
    await closeExplore();
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
        comment: z.string().max(300).nullable().optional().describe('Facebook/Instagram only, "full" videos only, and only while the video shows '
            + '"comments N/M allowed" with some left; omit or null otherwise (almost always). Written as the persona from doomscroll_start, the way '
            + 'she texts a friend in the account\'s language: all lowercase, no punctuation, no emojis, 2-10 words, casual, about something specific '
            + 'in this video, not polite, never generic. Punctuation, capitals and accents are stripped before typing anyway'),
    },
}, async ({ on_niche, watch, like_at_ms, save, comment }) => {
    if (!session) return failure('No session running; call doomscroll_start first');
    try {
        const plan = { onNiche: on_niche, watch, likeAtMs: like_at_ms ?? null, save: save ?? false, ...(comment ? { comment } : {}) };
        const result = await skipAutomatic(session, await session.step(plan));
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

const remotes = new RegistryWdaRemoteControl();

server.registerTool('type_text', {
    title: 'Type text on the phone',
    description: 'Types text on the phone like a person: opens the keyboard if needed (taps the given point, else the first text field on screen), '
        + 'then taps every key on the on-screen keyboard with human timing, switching to capitals/numbers/symbols as needed and '
        + 'occasionally slipping onto a neighbouring key and correcting it. Works with any keyboard layout. '
        + 'Letters that need a long-press (é on QWERTY…) are not supported. iOS autocorrect may still change words after a space.',
    inputSchema: {
        text: z.string().min(1).max(MAX_TYPING_LENGTH).describe('Text to type; \n presses return'),
        wpm: z.number().min(5).max(120).optional().describe('Typing speed in words per minute (default: random 28-44)'),
        typo_rate: z.number().min(0).max(0.3).optional().describe('Chance per letter of a corrected slip (default 0.02; 0 = never)'),
        field_x: z.number().optional().describe('X (points) of the text field to tap if the keyboard is closed'),
        field_y: z.number().optional().describe('Y (points) of the text field to tap if the keyboard is closed'),
        udid: z.string().optional().describe('Device UDID; only needed when several phones are registered'),
    },
}, async ({ text, wpm, typo_rate, field_x, field_y, udid }) => {
    if (session) return failure('A doomscroll session is running on the phone; call doomscroll_stop first');
    try {
        const device = resolveDevice(await loadRegisteredDevices(), udid);
        const remote = await remotes.control(device.udid);
        const field = field_x !== undefined && field_y !== undefined ? { x: field_x, y: field_y } : undefined;
        const report = await remote.typeText(device.udid, text, {
            field, wpm, typoRate: typo_rate,
            onTouch: (touch) => emitTouch(touch, { udid: device.udid }),
        });
        const seconds = (report.durationMs / 1000).toFixed(1);
        return {
            content: [{
                type: 'text' as const,
                text: `Typed ${JSON.stringify(report.text)} in ${seconds}s (${report.keystrokes} taps, ${report.typos} corrected slip${report.typos === 1 ? '' : 's'}, ~${report.wpm} WPM including keyboard reads)`,
            }],
        };
    } catch (error) {
        return failure(error);
    }
});

server.registerTool('comment_reel', {
    title: 'Comment on the Reel on screen',
    description: 'Leaves a comment on the Facebook or Instagram Reel the phone is showing right now (the app must already be open on a Reel; '
        + 'it is not relaunched). Taps the comment button, waits for the comment sheet, types the text like a person, taps send, '
        + 'checks the app took it, and closes the sheet. One line, letters/digits/basic punctuation: accents, emojis, hashtags, '
        + `mentions and links are dropped; max ${MAX_COMMENT_LENGTH} characters. Not available while a doomscroll runs: comments there go through doomscroll_step.`,
    inputSchema: {
        app: z.enum(['facebook', 'instagram']).describe('The app showing the Reel'),
        text: z.string().min(1).max(300).describe('The comment to leave'),
        udid: z.string().optional().describe('Device UDID; only needed when several phones are registered'),
    },
}, async ({ app, text, udid }) => {
    if (session) return failure('A doomscroll session is running on the phone; pass comment to doomscroll_step instead');
    const clean = sanitizeComment(text);
    if (!clean) return failure('Nothing typeable is left in that comment (it needs letters or digits)');
    try {
        const device = resolveDevice(await loadRegisteredDevices(), udid);
        const context = await connectApp(device, AGENT_ADAPTERS[app].bundleId, { launch: false });
        try {
            const outcome = await leaveComment(context, COMMENT_SHEETS[app], clean);
            const seconds = (outcome.durationMs / 1000).toFixed(1);
            return {
                content: [{
                    type: 'text' as const,
                    text: `${outcome.verified ? 'Commented' : 'Sent the comment (the text box did not empty, so it may not be posted)'} ${JSON.stringify(clean)} in ${seconds}s `
                        + `${JSON.stringify(outcome.steps)}${clean !== text ? ` (typed version of ${JSON.stringify(text)})` : ''}`,
                }],
            };
        } finally {
            await context.driver.deleteSession().catch(() => undefined);
        }
    } catch (error) {
        if (error instanceof AppStuckError) return failure(`${error.message}. Check the phone: the comment sheet may still be open`);
        return failure(error);
    }
});

server.registerTool('unlock_phone', {
    title: 'Unlock the phone',
    description: 'Wakes the phone and unlocks it with its saved passcode (devices.json, else IOS_PASSCODE), the same as the dashboard\'s Unlock button. '
        + 'Does nothing if it is already unlocked. Use it before reading or driving the screen when the phone may have gone to sleep.',
    inputSchema: {
        udid: z.string().optional().describe('Device UDID; only needed when several phones are registered'),
    },
}, async ({ udid }) => {
    if (session) return failure('A doomscroll session is running on the phone; it keeps the phone awake');
    try {
        const device = resolveDevice(await loadRegisteredDevices(), udid);
        const remote = await remotes.control(device.udid);
        if (!await remote.isLocked(device.udid)) {
            return { content: [{ type: 'text' as const, text: `${device.name.trim() || device.udid} is already unlocked` }] };
        }
        const started = Date.now();
        await remote.unlock(device.udid);
        const locked = await remote.isLocked(device.udid);
        if (locked) return failure('Unlock ran but the phone still reports locked; check its passcode on the device page');
        return { content: [{ type: 'text' as const, text: `Unlocked ${device.name.trim() || device.udid} in ${((Date.now() - started) / 1000).toFixed(1)}s` }] };
    } catch (error) {
        return failure(error);
    }
});

// Hands-on tools to work out a new flow on the real app before scripting it.
const APP_ARG = z.string().default('tiktok').describe('tiktok, facebook, instagram, or a bundle id; the app the session attaches to (default tiktok)');
const BUSY = 'A doomscroll session is running on the phone; call doomscroll_stop first';

async function lookContent(context: Awaited<ReturnType<typeof exploreContext>>, elements = true): Promise<Content[]> {
    const { image, text } = await look(context, { elements });
    return [{ type: 'image', data: image.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text }];
}

server.registerTool('phone_look', {
    title: 'Look at the phone screen',
    description: 'Screenshot of the phone plus the visible labelled elements of the accessibility tree (type, label, centre and size in points). '
        + 'Attaches to the app as it is on screen unless launch is true (cold relaunch). For working out a flow before scripting it.',
    inputSchema: {
        app: APP_ARG,
        launch: z.boolean().optional().describe('Relaunch the app from cold first (default false)'),
        elements: z.boolean().optional().describe('Include the element list (default true; turn off if the page source hangs)'),
        udid: z.string().optional().describe('Device UDID; only needed when several phones are registered'),
    },
}, async ({ app, launch, elements, udid }) => {
    if (session) return failure(BUSY);
    try {
        const context = await exploreContext(app, { launch: launch ?? false, ...(udid ? { udid } : {}) });
        return { content: await lookContent(context, elements ?? true) };
    } catch (error) {
        return failure(error);
    }
});

server.registerTool('phone_tap', {
    title: 'Tap the phone screen',
    description: 'Taps a point (in points, as phone_look reports) with a human-like tap, waits, and returns a fresh look at the screen.',
    inputSchema: {
        x: z.number(), y: z.number(),
        app: APP_ARG,
        wait_ms: z.number().int().min(0).max(10000).optional().describe('Wait before looking again (default 1500)'),
        elements: z.boolean().optional().describe('Include the element list in the look after (default true)'),
        udid: z.string().optional(),
    },
}, async ({ x, y, app, wait_ms, elements, udid }) => {
    if (session) return failure(BUSY);
    try {
        const context = await exploreContext(app, udid ? { udid } : {});
        await tap(context, x, y);
        await context.driver.pause(wait_ms ?? 1500);
        return { content: await lookContent(context, elements ?? true) };
    } catch (error) {
        return failure(error);
    }
});

server.registerTool('phone_swipe', {
    title: 'Swipe on the phone screen',
    description: 'Swipes from one point to another (points), waits, and returns a fresh look at the screen.',
    inputSchema: {
        from_x: z.number(), from_y: z.number(), to_x: z.number(), to_y: z.number(),
        duration_ms: z.number().int().min(100).max(3000).optional().describe('Default 450'),
        app: APP_ARG,
        wait_ms: z.number().int().min(0).max(10000).optional().describe('Wait before looking again (default 1500)'),
        elements: z.boolean().optional(),
        udid: z.string().optional(),
    },
}, async ({ from_x, from_y, to_x, to_y, duration_ms, app, wait_ms, elements, udid }) => {
    if (session) return failure(BUSY);
    try {
        const context = await exploreContext(app, udid ? { udid } : {});
        await swipe(context, { x: from_x, y: from_y }, { x: to_x, y: to_y }, duration_ms ?? 450);
        await context.driver.pause(wait_ms ?? 1500);
        return { content: await lookContent(context, elements ?? true) };
    } catch (error) {
        return failure(error);
    }
});

server.registerTool('phone_release', {
    title: 'Release the phone',
    description: 'Closes the session phone_look/phone_tap/phone_swipe keep open (the app stays as it is).',
    inputSchema: {},
}, async () => ({ content: [{ type: 'text' as const, text: await closeExplore() ? 'Released' : 'Nothing was open' }] }));

async function shutdown(): Promise<void> {
    const running = session;
    session = undefined;
    await running?.stop('stopped').catch(() => undefined);
    await closeExplore();
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
