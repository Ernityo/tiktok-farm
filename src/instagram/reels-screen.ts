// Reads the Instagram Reels screen from the accessibility tree (WDA's JSON
// page source) instead of the screenshot: Instagram labels everything the
// doomscroll needs — the Reels tab, the J'aime button and whether it is
// already pressed, "Sponsorisée" on ads, and the video progress.
//
// Labels below were read from the French iOS app on an iPhone XR (2026-11).
// Identifiers (like-button, reels-tab, ad-in-ufi-button) don't depend on the
// app language; the English labels are kept as a fallback.

/** One node of WDA's JSON page source (`mobile: source`, format json). */
export interface SourceNode {
    type?: string;
    name?: string | null;
    label?: string | null;
    value?: string | null;
    isVisible?: string | boolean;
    rect?: { x: number; y: number; width: number; height: number };
    children?: SourceNode[] | null;
}

export type ReelScreenKind =
    /** A normal Reel with the like/comment/share column. */
    | 'reel'
    /** A sponsored Reel or photo ("Sponsorisée"). */
    | 'ad'
    /** Anything else: suggestion and survey cards, Threads posts, pop-ups. */
    | 'other';

export interface ReelScreen {
    /** The Reels tab is the selected tab. */
    onReels: boolean;
    kind: ReelScreenKind;
    /** J'aime in the right-hand column, centre in points. Absent on 'other'. */
    like?: { x: number; y: number; liked: boolean };
    /** Share of the video played, 0..1. Absent on photos and some short Reels. */
    progress?: number;
    /** "Reel de <account>." — tells one Reel from the next. */
    reelId?: string;
}

/** `mobile: source` returns the tree as an object, or as a JSON string. */
export function parseSource(raw: unknown): SourceNode {
    const value = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Page source is not a JSON object');
    return value as SourceNode;
}

// Labels use non-breaking and narrow spaces ("Progression de la vidéo : 39 pourcent").
const normalize = (text: string | null | undefined) => (text ?? '').replace(/[  ‎]/g, ' ').trim();

const isVisible = (node: SourceNode) => node.isVisible === true || node.isVisible === '1';

const PROGRESS = /^(?:Progression de la vidéo|Video progress)\s*:\s*(\d{1,3})\s*(?:pourcent|percent|%)/i;
const REEL_ID = /^(?:Reel de|Reel sponsorisé de|Photo sponsorisée de|Reel by|Sponsored reel by|Sponsored photo by) (.+)$/i;
const SPONSORED_LABEL = /^(?:Sponsorisée?|Sponsored)$|^(?:Reel|Photo) sponsorisée? de |^Sponsored (?:reel|photo) by /i;
const LIKED_LABEL = /^(?:J’aime déjà|J'aime déjà|Liked|Unlike)/i;

/**
 * Classifies the current Reels screen. Only on-screen nodes count: the tree
 * can include the neighbouring Reel or carousel items scrolled off screen.
 */
export function readReelScreen(tree: SourceNode): ReelScreen {
    const screen = tree.rect ?? { x: 0, y: 0, width: 0, height: 0 };
    const onScreen = (node: SourceNode) => {
        const rect = node.rect;
        if (!rect || !isVisible(node)) return false;
        return rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= screen.width && rect.y + rect.height <= screen.height;
    };

    let onReels = false;
    let like: ReelScreen['like'];
    let sponsored = false;
    let progress: number | undefined;
    let reelId: string | undefined;

    const visit = (node: SourceNode) => {
        const name = normalize(node.name);
        const label = normalize(node.label);
        if (onScreen(node)) {
            if (name === 'reels-tab' && node.value === '1') onReels = true;
            // The Reel's J'aime sits in the right-hand column. Threads posts
            // shown inside Reels have small inline like buttons elsewhere;
            // those must not count.
            if (name === 'like-button' && !like && node.rect!.x + node.rect!.width / 2 >= screen.width * 0.8) {
                like = {
                    x: Math.round(node.rect!.x + node.rect!.width / 2),
                    y: Math.round(node.rect!.y + node.rect!.height / 2),
                    liked: node.value === '1' || LIKED_LABEL.test(label),
                };
            }
            if (name === 'ad-in-ufi-button' || SPONSORED_LABEL.test(label)) sponsored = true;
            const progressMatch = PROGRESS.exec(label);
            if (progressMatch && progress === undefined) progress = Math.min(100, Number(progressMatch[1])) / 100;
            const idMatch = REEL_ID.exec(label);
            if (idMatch && reelId === undefined) reelId = label;
        }
        for (const child of node.children ?? []) visit(child);
    };
    visit(tree);

    const kind: ReelScreenKind = !like ? 'other' : sponsored ? 'ad' : 'reel';
    return {
        onReels,
        kind,
        ...(like ? { like } : {}),
        ...(progress !== undefined ? { progress } : {}),
        ...(reelId ? { reelId } : {}),
    };
}

/** Centre of the Reels tab button, in points, when it is on screen. */
export function findReelsTab(tree: SourceNode): { x: number; y: number } | undefined {
    let found: { x: number; y: number } | undefined;
    const visit = (node: SourceNode) => {
        if (found) return;
        if (normalize(node.name) === 'reels-tab' && node.rect && isVisible(node)) {
            found = { x: Math.round(node.rect.x + node.rect.width / 2), y: Math.round(node.rect.y + node.rect.height / 2) };
            return;
        }
        for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
    return found;
}
