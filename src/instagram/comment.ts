// Instagram Reels' comment sheet, for the shared comment flow
// (src/agent/comment-flow.ts). Everything is found by id: the Reel's
// "comment-button" in the right-hand column, the sheet's "text-view" box and
// its "send-button" ("Publier un commentaire"), which shares its id with the
// Reel's share button, so only the one on the box's row counts.

import { elementsById, type CommentSheetSpec } from '../agent/comment-flow.js';

export const INSTAGRAM_COMMENT_SHEET: CommentSheetSpec = {
    label: 'Instagram',
    async commentButton(context) {
        // The home feed's posts have comment buttons too; the Reel's sits in the right-hand column.
        const found = (await elementsById(context, 'comment-button'))
            .find(({ rect }) => rect.x + rect.width / 2 >= context.window.width * 0.8 && rect.y + rect.height < context.window.height * 0.88);
        return found ? { x: Math.round(found.rect.x + found.rect.width / 2), y: Math.round(found.rect.y + found.rect.height / 2) } : undefined;
    },
    composerId: 'text-view',
    sendId: 'send-button',
};
