import { facebookAdapter } from '../facebook/agent-adapter.js';
import { instagramAdapter } from '../instagram/agent-adapter.js';
import { tiktokAdapter } from '../tiktok/agent-adapter.js';
import type { AgentApp } from './model.js';
import type { AgentAppAdapter } from './session.js';

/** The adapter that drives each app in the agentic doomscroll. */
export const AGENT_ADAPTERS: Record<AgentApp, AgentAppAdapter> = {
    tiktok: tiktokAdapter,
    facebook: facebookAdapter,
    instagram: instagramAdapter,
};
