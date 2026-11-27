// Step timings for each doomscroll video, written as `spans` on its line in
// decisions.jsonl and drawn by the run report (report.ts). Every value is in
// ms since the swipe that brought the video in finished; a pair is [start, end].

/** Who started the session: the CLI runner, the scheduled warm-up, or Claude through the MCP tools. */
export type SessionSource = 'runner' | 'warmup' | 'mcp';

export type Span = [number, number];

export interface VideoSpans {
    /** Wait before the screenshot (AGENT_SETTLE_MS); absent when 0. */
    settle?: Span;
    screenshot: Span;
    /** Shrinking the screenshot and cropping the caption for the model. */
    images: Span;
    /** Caption OCR (the code-side ad check and the "same video" check use it). */
    ocr: Span;
    /** The app's own checks on the screenshot (ads, cards, reel id). */
    inspect: Span;
    /** The observation was ready (images saved, checks done). */
    observed: number;
    /** The model call that decided this video (runner and warm-up only). */
    model?: Span;
    /** The plan reached the session. */
    decided: number;
    actions?: Array<{ kind: 'like' | 'save' | 'comment'; at: Span }>;
    /** The watch was over (timer, end of the video, or after a comment). */
    watched: number;
    follow?: Span;
    accountCheck?: Span;
    search?: Span;
    swipe?: Span;
    /** The next video was on screen (the swipe finished); the last video: the session ended. */
    end: number;
}

/**
 * Whether the runner starts the model call as soon as the frame is captured,
 * alongside the caption OCR (default). AGENT_EARLY_DECIDE=0 waits for the OCR
 * and the checks first, as before, to measure what the overlap saves.
 */
export function earlyDecideEnabled(): boolean {
    return process.env.AGENT_EARLY_DECIDE !== '0';
}
