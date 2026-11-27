// Facebook Reels' comment sheet, for the shared comment flow
// (src/agent/comment-flow.ts). The comment bubble comes from the same
// screenshot detection as the like button; the sheet is light, its empty
// text box reads "Commentez…" or "Commenter en tant que <name>" (seen on the
// personal profile, 2026-11-27), and a blue paper plane shows right of it
// once text is typed.

import type { CommentSheetSpec } from '../agent/comment-flow.js';
import { detectReelsControls } from './reels-controls.js';

export const FACEBOOK_COMMENT_SHEET: CommentSheetSpec = {
    label: 'Facebook',
    async commentButton(context) {
        const controls = await detectReelsControls(await context.screenshot(), context.scale);
        return controls?.comment;
    },
    placeholder: /commentez|commenter en tant que|[ée]crivez un commentaire|write a comment|comment as/i,
    // The like/comment/share column is back in full: the sheet is gone.
    async onFeed(context) {
        return Boolean(await detectReelsControls(await context.screenshot(), context.scale));
    },
};
