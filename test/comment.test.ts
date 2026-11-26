import assert from 'node:assert/strict';
import test from 'node:test';

import { commentAllowance, commentOpen, MAX_COMMENT_LENGTH, MAX_COMMENTS_PER_SESSION, sanitizeComment } from '../src/agent/comment.js';
import { parseReply, systemPrompt, userText } from '../src/agent/model.js';
import { timePlan } from '../src/agent/plan.js';
import { pickComposer, pickSend } from '../src/agent/comment-flow.js';

const niche = { description: 'cats', keywords: [], avoid: [] };
const screen = { width: 414, height: 896 };

test('comments read like a text message: lowercase, no punctuation, accents, emojis, tags or links', () => {
    assert.equal(sanitizeComment('Trop mignon ce chat 😍 #chat @bob'), 'trop mignon ce chat');
    assert.equal(sanitizeComment('Ça c’est génial,\nvraiment… œuvre!'), 'ca cest genial vraiment oeuvre');
    assert.equal(sanitizeComment("J'attends la partie 3 !!"), 'jattends la partie 3');
    assert.equal(sanitizeComment('va voir https://x.com/abc stp'), 'va voir stp');
    assert.equal(sanitizeComment('😍🔥!!'), undefined);
    assert.equal(sanitizeComment(''), undefined);
    assert.equal(sanitizeComment(null), undefined);
});

test('the persona and texting style go into the comment rules', () => {
    const prompt = systemPrompt({ ...niche, persona: '30-year-old French barista' }, 'casual', 'French', 'instagram');
    assert.match(prompt, /30-year-old French barista/);
    assert.match(prompt, /all lowercase, no punctuation/);
});

test('long comments are cut at a word near the limit', () => {
    const long = 'tres beau chat '.repeat(20);
    const clean = sanitizeComment(long)!;
    assert.ok(clean.length <= MAX_COMMENT_LENGTH);
    assert.ok(clean.endsWith('chat') || clean.endsWith('beau') || clean.endsWith('tres'));
});

test('the comment allowance starts at zero and is capped per session', () => {
    assert.equal(commentAllowance(5, 0.03), 0);
    assert.equal(commentAllowance(20, 0.03), 1);
    assert.equal(commentAllowance(1000, 0.5), MAX_COMMENTS_PER_SESSION);
    assert.equal(commentAllowance(1000, 0), 0);
});

test('a comment is timed only on a full watch within the allowance, after the like', () => {
    const plan = { onNiche: 0.9, watch: 'full' as const, likeAtMs: 8000, comment: 'il est trop drole 😂' };
    const keep = () => 0.2;
    const timed = timePlan(plan, 'engaged', { judged: 40, likes: 0, saves: 0, comments: 0 }, keep);
    assert.equal(timed.comment, 'il est trop drole');
    assert.ok(timed.commentAtMs! > timed.likeAtMs!);
    assert.ok(timed.watchMs > timed.commentAtMs!);

    // Too early in the session: no allowance yet.
    assert.equal(timePlan(plan, 'engaged', { judged: 2, likes: 0, saves: 0 }, keep).comment, undefined);
    // Skimmers never comment.
    assert.equal(timePlan(plan, 'skimmer', { judged: 400, likes: 0, saves: 0 }, keep).comment, undefined);
    // Not on a short watch.
    assert.equal(timePlan({ ...plan, watch: 'short' }, 'engaged', { judged: 40, likes: 0, saves: 0 }, keep).comment, undefined);
    // Allowance used up.
    assert.equal(timePlan(plan, 'engaged', { judged: 40, likes: 0, saves: 0, comments: 2 }, keep).comment, undefined);
});

test('comments are spread out: most model comments are dropped, and never two close together', () => {
    const plan = { onNiche: 0.9, watch: 'full' as const, comment: 'trop beau' };
    // Above the keep chance: dropped even though one is allowed.
    assert.equal(timePlan(plan, 'engaged', { judged: 40, likes: 0, saves: 0 }, () => 0.5).comment, undefined);
    // Allowed by the rate, but only 5 videos after the last comment.
    assert.equal(timePlan(plan, 'engaged', { judged: 40, likes: 0, saves: 0, comments: 1, lastCommentAt: 35 }, () => 0.2).comment, undefined);
    assert.ok(!commentOpen(41, 1, 35, 0.5));
    assert.ok(commentOpen(48, 1, 35, 0.5));
    assert.ok(commentOpen(48, 0, undefined, 0.5));
});

test('the model reply carries a comment only on a full watch', () => {
    assert.equal(parseReply('{"on_niche": 0.9, "watch": "full", "like": true, "comment": "trop beau"}').plan.comment, 'trop beau');
    assert.equal(parseReply('{"on_niche": 0.5, "watch": "short", "comment": "trop beau"}').plan.comment, undefined);
    assert.equal(parseReply('{"on_niche": 0.9, "watch": "full", "comment": null}').plan.comment, undefined);
    // A plan without a comment keeps its old shape.
    assert.deepEqual(parseReply('{"on_niche": 0.9, "watch": "full", "like": false}').plan, { onNiche: 0.9, watch: 'full', likeAtMs: null, save: false });
});

test('facebook and instagram prompts ask for comments, tiktok not; the comments line shows while one is left', () => {
    assert.match(systemPrompt(niche, 'casual', 'French', 'facebook'), /"comment": "text"\|null/);
    assert.match(systemPrompt(niche, 'casual', 'French', 'instagram'), /"comment": "text"\|null/);
    assert.doesNotMatch(systemPrompt(niche, 'casual'), /comment/);
    const base = { video: 1, image: Buffer.alloc(0), caption: 'x', isAd: false };
    const engagement = { likes: 0, likesAllowed: 1, saves: 0, savesAllowed: 0 };
    assert.match(userText({ ...base, engagement: { ...engagement, comments: 0, commentsAllowed: 1 } }), /comments 0\/1 allowed/);
    assert.doesNotMatch(userText({ ...base, engagement: { ...engagement, comments: 1, commentsAllowed: 1 } }), /comments/);
    assert.doesNotMatch(userText({ ...base, engagement }), /comments/);
});

// Measured on the iPhone XR (Instagram, 11/2026): the box at y 555 above the keyboard,
// "Publier un commentaire" on its row, and the Reel's share button (same id) behind the sheet.
const box = { id: 'box', rect: { x: 72, y: 555, width: 268, height: 29 } };

test('the text box is the lowest match in the lower part of the screen', () => {
    const top = { id: 'top', rect: { x: 10, y: 60, width: 300, height: 30 } };
    assert.equal(pickComposer([top, box], screen.height)?.id, 'box');
    assert.equal(pickComposer([top], screen.height), undefined);
});

test('the send button is the one on the text box rows, never the Reel share button', () => {
    const share = { id: 'share', rect: { x: 361, y: 565 - 120, width: 45, height: 44 } };
    const publish = { id: 'publish', rect: { x: 340, y: 553, width: 50, height: 32 } };
    assert.equal(pickSend([share, publish], box.rect)?.id, 'publish');
    assert.equal(pickSend([share], box.rect), undefined);
    // A long comment grows the box upwards; the button sits on its last row.
    const tall = { x: 72, y: 500, width: 268, height: 84 };
    assert.equal(pickSend([share, publish], tall)?.id, 'publish');
});
