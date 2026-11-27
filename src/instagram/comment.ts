// Instagram Reels' comment sheet, for the shared comment flow
// (src/agent/comment-flow.ts). The Reel's comment bubble comes from the rail
// detection on a screenshot (reels-screen.ts); the sheet is dark, its empty
// text box reads "Rejoignez la conversation…", and a blue round send button
// shows right of it once text is typed.

import type { CommentSheetSpec } from '../agent/comment-flow.js';
import { readReelScreenshot } from './reels-screen.js';

export const INSTAGRAM_COMMENT_SHEET: CommentSheetSpec = {
    label: 'Instagram',
    async commentButton(context) {
        const screen = await readReelScreenshot(await context.screenshot(), context.scale);
        // Not on an ad or a card: only a Reel's own rail.
        return screen.onReels && screen.kind === 'reel' ? screen.comment : undefined;
    },
    placeholder: /rejoignez la conversation|join the conversation|ajouter un commentaire|add a comment/i,
    // The Reels tab shows again: the sheet (which covers the tab bar) is gone.
    async onFeed(context) {
        return (await readReelScreenshot(await context.screenshot(), context.scale)).onReels;
    },
};
