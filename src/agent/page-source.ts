import type { Browser } from 'webdriverio';

import { parseSource, type SourceNode } from '../instagram/reels-screen.js';

/** TikTok's feed can make the page source hang; give up rather than block. */
const SOURCE_TIMEOUT_MS = 15000;

/** WDA's JSON accessibility tree of the app on screen, with a timeout. */
export async function readSource(context: { driver: Browser }, timeoutMs = SOURCE_TIMEOUT_MS): Promise<SourceNode> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`page source took over ${timeoutMs / 1000}s`)), timeoutMs);
    });
    try {
        return parseSource(await Promise.race([context.driver.execute('mobile: source', { format: 'json' }), timeout]));
    } finally {
        clearTimeout(timer);
    }
}
