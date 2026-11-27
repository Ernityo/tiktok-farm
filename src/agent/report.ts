// Latency reports for doomscroll runs, as local HTML files that open offline:
// each run folder in .agent-runs gets a report.html (waterfall of every video,
// step-time distributions, video table), and .agent-runs/index.html lists all
// runs and puts up to three side by side. Written when a session stops; this
// command rewrites them all (e.g. for runs recorded before the reports):
//
//   npm run agent:report [-- .agent-runs/<run>]

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { VideoSpans } from './trace.js';

export const RUNS_DIRECTORY = path.resolve('.agent-runs');
const PAGE_DIRECTORY = new URL('./report/', import.meta.url);

/** One video, trimmed to what the report draws. */
export interface ReportVideo {
    video: number;
    watch?: string;
    onNiche?: number;
    auto?: string;
    caption: string;
    place?: string;
    screenMs?: number;
    modelMs?: number;
    provider?: string;
    /** The planned time on screen. */
    watchMs?: number;
    liked?: boolean;
    saved?: boolean;
    commented?: boolean;
    followed?: boolean;
    retries?: number;
    spans?: VideoSpans;
}

export interface ReportRun {
    /** The run folder's name. */
    id: string;
    app: string;
    account?: string;
    source?: string;
    personality?: string;
    startedAt?: string;
    settings?: { settleMs?: number; earlyDecide?: boolean };
    model?: string;
    warmup?: unknown;
    reason?: string;
    elapsedMs?: number;
    videos: ReportVideo[];
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
    try {
        return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

function reportVideo(line: Record<string, unknown>): ReportVideo {
    const plan = (line.plan ?? {}) as Record<string, unknown>;
    const timed = (line.timed ?? {}) as Record<string, unknown>;
    const pick = <T>(key: string, value: T | undefined) => (value === undefined ? {} : { [key]: value });
    return {
        video: number(line.video) ?? 0,
        caption: (text(line.caption) ?? '').slice(0, 120),
        ...pick('watch', text(plan.watch)),
        ...pick('onNiche', number(plan.onNiche)),
        ...pick('auto', text(line.auto)),
        ...pick('place', text(line.place)),
        ...pick('screenMs', number(line.screenMs)),
        ...pick('modelMs', number(line.modelMs)),
        ...pick('provider', text(line.provider)),
        ...pick('watchMs', number(timed.watchMs)),
        ...(line.liked === true ? { liked: true } : {}),
        ...(line.saved === true ? { saved: true } : {}),
        ...(line.commented ? { commented: true } : {}),
        ...(line.followed ? { followed: true } : {}),
        ...(Array.isArray(line.retrySwipes) && line.retrySwipes.length ? { retries: line.retrySwipes.length } : {}),
        ...(line.spans && typeof line.spans === 'object' ? { spans: line.spans as VideoSpans } : {}),
    };
}

/** Reads a run folder; undefined when it holds neither a session nor decisions. */
export async function loadRun(directory: string): Promise<ReportRun | undefined> {
    const session = await readJson(path.join(directory, 'session.json'));
    const raw = await readFile(path.join(directory, 'decisions.jsonl'), 'utf8').catch(() => '');
    const lines = raw.split('\n').filter(Boolean).flatMap((line): Array<Record<string, unknown>> => {
        try {
            return [JSON.parse(line) as Record<string, unknown>];
        } catch {
            return [];
        }
    });
    if (!session && !lines.length) return undefined;
    const summary = await readJson(path.join(directory, 'summary.json'));
    const id = path.basename(directory);
    const meta = (session?.meta ?? {}) as Record<string, unknown>;
    const run: ReportRun = {
        id,
        app: text(session?.app) ?? /-(tiktok|facebook|instagram)-/.exec(id)?.[1] ?? 'unknown',
        videos: lines.map(reportVideo),
    };
    const account = text(session?.account);
    if (account) run.account = account;
    const source = text(session?.source);
    if (source) run.source = source;
    const personality = text(session?.personality);
    if (personality) run.personality = personality;
    const startedAt = text(session?.startedAt);
    if (startedAt) run.startedAt = startedAt;
    if (session?.settings && typeof session.settings === 'object') run.settings = session.settings as ReportRun['settings'] & object;
    const model = lines.map((line) => text(line.model)).find(Boolean);
    if (model) run.model = model;
    if (meta.warmup) run.warmup = meta.warmup;
    const reason = text(summary?.reason);
    if (reason) run.reason = reason;
    const elapsedMs = number(summary?.elapsedMs);
    if (elapsedMs !== undefined) run.elapsedMs = elapsedMs;
    return run;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A self-contained page: the data inline as JSON, drawn by page.js. */
export async function renderReport(runs: ReportRun[], kind: 'run' | 'index'): Promise<string> {
    const [css, js] = await Promise.all([
        readFile(new URL('page.css', PAGE_DIRECTORY), 'utf8'),
        readFile(new URL('page.js', PAGE_DIRECTORY), 'utf8'),
    ]);
    const title = kind === 'index'
        ? 'Doomscroll runs'
        : `Doomscroll run · ${runs[0]?.app ?? ''} ${runs[0]?.account ?? ''}`.trim();
    // `<` escaped so a caption can't close the script tag.
    const data = JSON.stringify({ kind, runs }).replace(/</g, '\\u003c');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
</head>
<body>
<main id="app"></main>
<div id="tooltip" role="tooltip" hidden></div>
<script id="data" type="application/json">${data}</script>
<script>${js}</script>
</body>
</html>
`;
}

async function runDirectories(runsDirectory: string): Promise<string[]> {
    const entries = await readdir(runsDirectory, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(runsDirectory, entry.name)).sort();
}

/** Rewrites .agent-runs/index.html from every run folder in it. */
export async function writeIndex(runsDirectory = RUNS_DIRECTORY): Promise<string> {
    const runs = (await Promise.all((await runDirectories(runsDirectory)).map(loadRun)))
        .filter((run): run is ReportRun => run !== undefined)
        .reverse();
    const file = path.join(runsDirectory, 'index.html');
    await writeFile(file, await renderReport(runs, 'index'));
    return file;
}

/** Writes the run's report.html, then refreshes the index next to it. */
export async function writeRunReport(directory: string): Promise<string | undefined> {
    const run = await loadRun(directory);
    if (!run) return undefined;
    const file = path.join(directory, 'report.html');
    await writeFile(file, await renderReport([run], 'run'));
    await writeIndex(path.dirname(directory));
    return file;
}

async function main(): Promise<void> {
    const only = process.argv[2];
    const directories = only ? [path.resolve(only)] : await runDirectories(RUNS_DIRECTORY);
    for (const directory of directories) {
        const run = await loadRun(directory);
        if (run) await writeFile(path.join(directory, 'report.html'), await renderReport([run], 'run'));
    }
    const index = await writeIndex(only ? path.dirname(path.resolve(only)) : RUNS_DIRECTORY);
    console.log(`[report] ${directories.length} run${directories.length === 1 ? '' : 's'} · open ${index}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
    await main();
}
