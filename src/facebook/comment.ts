// Facebook Reels' comment sheet, for the shared comment flow
// (src/agent/comment-flow.ts). The comment bubble comes from the same
// screenshot detection as the like button; the sheet's text box and its
// "Publier" button (shown once text is typed) are found by id.

import type { CommentSheetSpec } from '../agent/comment-flow.js';
import { detectReelsControls } from './reels-controls.js';

export const FACEBOOK_COMMENT_SHEET: CommentSheetSpec = {
    label: 'Facebook',
    async commentButton(context) {
        const controls = await detectReelsControls(await context.screenshot(), context.scale);
        return controls?.comment;
    },
    composerId: 'comment-composer-text-area',
    sendId: 'comment-composer-confirm-button',
    // The like/comment/share column is back in full: the sheet is gone.
    async onFeed(context) {
        return Boolean(await detectReelsControls(await context.screenshot(), context.scale));
    },
};
