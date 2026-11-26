import type { JsonObject, JsonValue, RegisteredDevice } from '@git-agni/phone-farm-core';

import { TIKTOK_PLUGIN_ID } from './runtime-settings.js';

/**
 * What one TikTok account's feed should be about. Stored per account under
 * `pluginData["com.git-agni.tiktok"].niches["@handle"]` in devices.json, next
 * to the plain `accounts` list (which stays a list of strings so every other
 * reader of it keeps working). Other social plugins use the same shape under
 * their own plugin id.
 */
export interface Niche {
    /** Free text: what on-niche videos look like. */
    description: string;
    /** Words or hashtags that usually mean on-niche. */
    keywords: string[];
    /** Topics to treat as off-niche even if they look close. */
    avoid: string[];
    /**
     * Who the account is (e.g. "30-year-old French woman, barista, watches AI
     * stories to unwind"): the voice of its comments, and what the first warm-up
     * phase teaches the feed before the niche (src/tiktok/warmup.ts).
     */
    persona?: string;
}

export const NICHE_LIMITS = { description: 1000, listItems: 50, item: 80, persona: 500 } as const;

export function normalizeHandle(handle: string): string {
    const trimmed = handle.trim();
    return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

function stringList(value: JsonValue | undefined, name: string): string[] {
    if (value === undefined) return [];
    const raw = typeof value === 'string' ? value.split(',') : value;
    if (!Array.isArray(raw)) throw new Error(`${name} must be a list of strings`);
    const items = raw.map((entry) => {
        if (typeof entry !== 'string') throw new Error(`${name} must be a list of strings`);
        return entry.trim();
    }).filter(Boolean);
    const unique = [...new Set(items)];
    if (unique.length > NICHE_LIMITS.listItems) throw new Error(`${name} can have at most ${NICHE_LIMITS.listItems} entries`);
    if (unique.some((entry) => entry.length > NICHE_LIMITS.item)) {
        throw new Error(`Each ${name} entry must be ${NICHE_LIMITS.item} characters or fewer`);
    }
    return unique;
}

/** Validates and normalizes a niche from user input or devices.json. */
export function parseNiche(value: JsonValue | undefined): Niche {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Niche must be an object');
    const description = typeof value.description === 'string' ? value.description.trim() : '';
    if (!description) throw new Error('Describe the niche');
    if (description.length > NICHE_LIMITS.description) {
        throw new Error(`Niche description must be ${NICHE_LIMITS.description} characters or fewer`);
    }
    const persona = typeof value.persona === 'string' ? value.persona.trim() : '';
    if (persona.length > NICHE_LIMITS.persona) throw new Error(`Persona must be ${NICHE_LIMITS.persona} characters or fewer`);
    return {
        description, keywords: stringList(value.keywords, 'keywords'), avoid: stringList(value.avoid, 'avoid'),
        ...(persona ? { persona } : {}),
    };
}

function storedNiches(device: RegisteredDevice | undefined, pluginId: string): JsonObject {
    const value = device?.pluginData[pluginId]?.niches;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** Every valid niche on the device, keyed by "@handle". Invalid entries are skipped. */
export function accountNiches(device: RegisteredDevice | undefined, pluginId = TIKTOK_PLUGIN_ID): Record<string, Niche> {
    const result: Record<string, Niche> = {};
    for (const [handle, value] of Object.entries(storedNiches(device, pluginId))) {
        try {
            result[normalizeHandle(handle)] = parseNiche(value);
        } catch {
            // A hand-edited, broken entry shouldn't break the dashboard or a run.
        }
    }
    return result;
}

export function nicheForAccount(device: RegisteredDevice | undefined, handle: string, pluginId = TIKTOK_PLUGIN_ID): Niche | undefined {
    return accountNiches(device, pluginId)[normalizeHandle(handle)];
}

/** Drops niches of accounts that are no longer configured on the device. */
export function pruneNiches(niches: Record<string, Niche>, accounts: readonly string[]): Record<string, Niche> {
    const keep = new Set(accounts.map(normalizeHandle));
    return Object.fromEntries(Object.entries(niches).filter(([handle]) => keep.has(handle)));
}

export function nicheToJson(niche: Niche): JsonObject {
    return {
        description: niche.description, keywords: [...niche.keywords], avoid: [...niche.avoid],
        ...(niche.persona ? { persona: niche.persona } : {}),
    };
}

export function nichesToJson(niches: Record<string, Niche>): JsonObject {
    return Object.fromEntries(Object.entries(niches).map(([handle, niche]) => [handle, nicheToJson(niche)]));
}
