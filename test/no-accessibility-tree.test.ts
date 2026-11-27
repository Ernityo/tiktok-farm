import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// WDA's accessibility tree (page source, element lookups) is slow on busy
// screens and can hang WDA and the app: screens are read off screenshots
// (docs/screenshot-migration.md). This keeps it from coming back.
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const PATTERNS: Array<[string, RegExp]> = [
    ['page source', /mobile: source|\/source\b|getPageSource/],
    ['element lookup', /\bdriver\.\$\$?\(|\.\$\$?\(\s*['"`]|findElements?\(|\/elements?\b['"`]|getElementRect|getElementAttribute|isDisplayed\(/],
    ['element query', /predicate string|class chain|accessibility id/i],
];
// Not moved yet: "Use this sound" when posting (docs/screenshot-migration.md, "Later").
const ALLOWED = new Set(['tiktok/post.ts']);

async function sourceFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.map((entry) => {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return Promise.resolve(entry.name.endsWith('.ts') ? [full] : []);
    }));
    return files.flat();
}

test('nothing in src/ reads the accessibility tree', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
        const relative = path.relative(SRC, file).split(path.sep).join('/');
        if (ALLOWED.has(relative)) continue;
        const lines = (await readFile(file, 'utf8')).split('\n');
        lines.forEach((line, index) => {
            if (/^\s*(\/\/|\*)/.test(line)) return; // comments may mention it
            for (const [what, pattern] of PATTERNS) {
                if (pattern.test(line)) offenders.push(`${relative}:${index + 1} (${what}): ${line.trim()}`);
            }
        });
    }
    assert.deepEqual(offenders, []);
});
