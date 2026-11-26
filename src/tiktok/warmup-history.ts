import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { localDate, type WarmupState } from './warmup.js';

/** One finished agentic session of an account, as read from its run folder. */
export interface WarmupRun {
    /** YYYY-MM-DD in the warm-up's timezone. */
    date: string;
    startedAt: string;
    phase?: string;
    day?: number;
    reason?: string;
    feedVideos: number;
    feedOnNicheShare: number;
    likes: number;
    follows: number;
    search?: { query: string; videos: number; error?: string };
}

const RUNS_DIRECTORY = path.resolve('.agent-runs');

/**
 * The account's TikTok sessions on this phone since the warm-up started,
 * oldest first, from `.agent-runs/<stamp>-tiktok-<handle>/` (session.json +
 * summary.json). Runs without a summary (running or crashed) are left out.
 */
export async function warmupRuns(udid: string, account: string, state: WarmupState, runs = RUNS_DIRECTORY): Promise<WarmupRun[]> {
    const suffix = `-tiktok-${account.replace(/^@/, '')}`;
    const entries = (await readdir(runs).catch(() => [] as string[])).filter((entry) => entry.endsWith(suffix)).sort();
    const result: WarmupRun[] = [];
    for (const entry of entries) {
        try {
            const session = JSON.parse(await readFile(path.join(runs, entry, 'session.json'), 'utf8')) as { udid?: string; startedAt?: string };
            if (session.udid !== udid || !session.startedAt) continue;
            const date = localDate(new Date(session.startedAt), state.timezone);
            if (date < state.startedOn) continue;
            const summary = JSON.parse(await readFile(path.join(runs, entry, 'summary.json'), 'utf8')) as {
                reason?: string; feedVideos?: number; feedOnNicheShare?: number; likes?: number; follows?: number;
                search?: WarmupRun['search']; meta?: { warmup?: { phase?: string; day?: number } };
            };
            result.push({
                date, startedAt: session.startedAt,
                ...(summary.meta?.warmup?.phase ? { phase: summary.meta.warmup.phase } : {}),
                ...(summary.meta?.warmup?.day ? { day: summary.meta.warmup.day } : {}),
                ...(summary.reason ? { reason: summary.reason } : {}),
                feedVideos: summary.feedVideos ?? 0, feedOnNicheShare: summary.feedOnNicheShare ?? 0,
                likes: summary.likes ?? 0, follows: summary.follows ?? 0,
                ...(summary.search ? { search: summary.search } : {}),
            });
        } catch {
            // No summary yet, or a broken file: not a finished run.
        }
    }
    return result;
}

/** Whether a session already searched on `date` (at least one result video watched). */
export function searchedOn(runs: readonly WarmupRun[], date: string): boolean {
    return runs.some((run) => run.date === date && (run.search?.videos ?? 0) > 0);
}

/** On-niche share of For You videos per day, weighted by videos (niche-phase sessions only). */
export function dailyFeedShare(runs: readonly WarmupRun[], phase = 'niche'): Array<{ date: string; videos: number; share: number }> {
    const byDate = new Map<string, { videos: number; onNiche: number }>();
    for (const run of runs) {
        if (run.phase !== phase || !run.feedVideos) continue;
        const day = byDate.get(run.date) ?? { videos: 0, onNiche: 0 };
        day.videos += run.feedVideos;
        day.onNiche += run.feedVideos * run.feedOnNicheShare;
        byDate.set(run.date, day);
    }
    return [...byDate].map(([date, { videos, onNiche }]) => ({ date, videos, share: Math.round((onNiche / videos) * 100) / 100 }));
}
