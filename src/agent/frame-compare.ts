// AGENT_FRAME_COMPARE=1: every video is read from an MJPEG frame (what the
// session acts on) and from a /screenshot taken right after it. Both go
// through the same code-side checks and the same model; the model also judges
// the MJPEG frame a second time, so its own run-to-run noise can be told
// apart from a real difference between the two sources. One line per video
// goes to compare.jsonl in the run folder, and a summary is logged at the end.

import { appendFile } from 'node:fs/promises';
import path from 'node:path';

import type { DecisionInput, OpenRouterDecider } from './model.js';
import { sameCaption, type AgentPlan } from './plan.js';
import type { FrameReading, Observation } from './session.js';

interface Judged {
    watch: AgentPlan['watch'];
    onNiche: number;
    like: boolean;
}

interface Row {
    video: number;
    code: {
        sameCaption: boolean;
        sameAd: boolean;
        sameNoControls: boolean;
        sameAutoSkip: boolean;
    };
    mjpeg: Omit<FrameReading, 'image' | 'captionImage'>;
    png: Omit<FrameReading, 'image' | 'captionImage'> & { grabMs: number };
    /** Model answers; absent when either source was skipped in code. */
    model?: { acted?: Judged; mjpegAgain?: Judged; png?: Judged; error?: string };
}

const judged = (plan: AgentPlan): Judged => ({ watch: plan.watch, onNiche: plan.onNiche, like: plan.likeAtMs !== null });
const text = ({ image: _image, captionImage: _captionImage, ...rest }: FrameReading) => rest;

export class FrameComparer {
    private readonly pending: Array<Promise<void>> = [];
    private readonly rows: Row[] = [];

    constructor(private readonly decider: OpenRouterDecider, private readonly log: (line: string) => void) {}

    /** `acted`: the plan the session carried out on the MJPEG frame (absent when skipped in code). */
    add(observation: Observation, acted: AgentPlan | undefined): void {
        const compare = observation.compare;
        if (!compare) return;
        const { mjpeg, png } = compare;
        const row: Row = {
            video: observation.video,
            code: {
                sameCaption: sameCaption(mjpeg.caption, png.caption),
                sameAd: mjpeg.isAd === png.isAd,
                sameNoControls: mjpeg.noControls === png.noControls,
                sameAutoSkip: (mjpeg.autoSkip ?? null) === (png.autoSkip ?? null),
            },
            mjpeg: text(mjpeg),
            png: { ...text(png), grabMs: png.grabMs },
        };
        const input = (frame: FrameReading): DecisionInput => ({
            video: observation.video, image: frame.image, captionImage: frame.captionImage, engagement: observation.engagement, isAd: false,
        });
        const work = (async () => {
            if (!mjpeg.autoSkip && !png.autoSkip) {
                try {
                    const [again, fromPng] = await Promise.all([this.decider.decide(input(mjpeg)), this.decider.decide(input(png))]);
                    row.model = { ...(acted ? { acted: judged(acted) } : {}), mjpegAgain: judged(again.plan), png: judged(fromPng.plan) };
                } catch (error) {
                    row.model = { error: error instanceof Error ? error.message : String(error) };
                }
            }
            this.rows.push(row);
            await appendFile(path.join(compare.directory, 'compare.jsonl'), `${JSON.stringify(row)}\n`).catch(() => undefined);
        })();
        this.pending.push(work);
    }

    /** Waits for the last comparisons and logs the summary. */
    async finish(): Promise<void> {
        await Promise.allSettled(this.pending);
        if (!this.rows.length) return;
        const rows = [...this.rows].sort((a, b) => a.video - b.video);
        const count = (test: (row: Row) => boolean) => rows.filter(test).length;
        this.log(`frame comparison over ${rows.length} videos (MJPEG vs /screenshot):`);
        this.log(`  code: caption ${count((r) => r.code.sameCaption)}/${rows.length} same, ad ${count((r) => r.code.sameAd)}, `
            + `no-controls ${count((r) => r.code.sameNoControls)}, auto-skip ${count((r) => r.code.sameAutoSkip)}`);
        const judgedRows = rows.filter((r) => r.model?.acted && r.model.mjpegAgain && r.model.png);
        if (judgedRows.length) {
            const pair = (a: keyof NonNullable<Row['model']>, b: keyof NonNullable<Row['model']>) => {
                const pairs = judgedRows.map((r) => [r.model![a] as Judged, r.model![b] as Judged] as const);
                const watch = pairs.filter(([x, y]) => x.watch === y.watch).length;
                const like = pairs.filter(([x, y]) => x.like === y.like).length;
                const drift = pairs.reduce((sum, [x, y]) => sum + Math.abs(x.onNiche - y.onNiche), 0) / pairs.length;
                return `watch ${watch}/${pairs.length} same, like ${like}/${pairs.length}, mean |onNiche diff| ${drift.toFixed(2)}`;
            };
            this.log(`  model, MJPEG vs MJPEG again (its own noise): ${pair('acted', 'mjpegAgain')}`);
            this.log(`  model, MJPEG vs /screenshot:                 ${pair('acted', 'png')}`);
        }
        const grab = rows.map((r) => r.png.grabMs).sort((a, b) => a - b);
        this.log(`  /screenshot grab median ${grab[Math.floor(grab.length / 2)]} ms; frames in compare.jsonl and NNNN.jpg / NNNN-png.jpg`);
    }
}
