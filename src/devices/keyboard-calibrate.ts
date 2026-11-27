// Makes a keyboard reference (screen-keyboard.ts) from a screenshot of one
// keyboard layer:
//
//   npm run keyboard:calibrate -- --set <name> --layer <lower|upper|numbers|symbols|...> \
//       --screenshot <file> [--scale 2] \
//       [--row "a z e r t y u i o p" --row "q s d …" --row "~shift w x … delete" --row "123 espace @ #"]
//
// Without --row it finds the key caps, OCRs each one and prints the labels it
// proposes (single letters often come out wrong) — check every key against
// the screenshot, fix them, and run again with one --row per key row (labels
// separated by spaces) to write the reference. A "~" before a label
// leaves that key out of the comparison and of typing (its look changes with
// what's typed: the accent key, shift on the letter layers). Keys with a word
// for a label (shift, delete, 123, ABC, #+=, espace, retour) are never typed
// as characters; the typing engine finds them by position.
//
// Screenshots saved by a mismatch (logs/keyboard-mismatch/) are the ones to
// calibrate from.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import sharp from 'sharp';

import { findKeyRows, KEYBOARD_DIR, type KeyboardReferenceFile, type ReferenceKey } from './screen-keyboard.js';
import { recognizeWords } from '../tiktok/ocr.js';

const { values } = parseArgs({
    options: {
        set: { type: 'string' },
        layer: { type: 'string' },
        screenshot: { type: 'string' },
        scale: { type: 'string', default: '2' },
        row: { type: 'string', multiple: true },
    },
});
if (!values.set || !values.layer || !values.screenshot) {
    console.error('Usage: npm run keyboard:calibrate -- --set <name> --layer <name> --screenshot <file> [--scale 2] [--row "<labels>" ×4]');
    process.exit(1);
}
if (!/^[\w.-]+$/.test(values.set) || !/^[\w-]+$/.test(values.layer)) throw new Error('--set and --layer must be plain names');
const scale = Number(values.scale);

const screenshot = await readFile(values.screenshot);
const { data, info } = await sharp(screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const pixels = { data, width: info.width, height: info.height, channels: info.channels };
const found = findKeyRows(pixels, scale);
if (!found) throw new Error('No keyboard found on this screenshot (expected 4 rows of keys in the lower half)');
console.log(`Found ${found.rows.map((row) => row.length).join(' + ')} keys, rows ${found.top}..${found.bottom} px`);

if (!values.row?.length) {
    // Proposal only: OCR each key cap on its own (dark text on light caps, or the reverse).
    const proposal: string[] = [];
    for (const row of found.rows) {
        const labels: string[] = [];
        for (const rect of row) {
            const crop = sharp(screenshot).extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height }).greyscale().resize({ width: rect.width * 3 });
            const [dark, light] = await Promise.all([
                recognizeWords(await crop.clone().withMetadata({ density: 300 }).png().toBuffer(), 0),
                recognizeWords(await crop.clone().negate({ alpha: false }).withMetadata({ density: 300 }).png().toBuffer(), 0),
            ]);
            const best = [...dark, ...light].sort((a, b) => b.confidence - a.confidence)[0];
            labels.push(best?.text.trim() || '?');
        }
        proposal.push(labels.join(' '));
    }
    console.log('Proposed labels (check every key against the screenshot, then run again with them):');
    console.log(proposal.map((row) => `  --row ${JSON.stringify(row)}`).join(' \\\n'));
    process.exit(0);
}

const rows = values.row.map((row) => row.trim().split(/\s+/));
if (rows.length !== found.rows.length || rows.some((row, index) => row.length !== found.rows[index]!.length)) {
    throw new Error(`--row has ${rows.map((row) => row.length).join(' + ')} keys; the screenshot has ${found.rows.map((row) => row.length).join(' + ')}`);
}
const keys: ReferenceKey[] = rows.flatMap((row, rowIndex) => row.map((raw, index) => {
    const rect = found.rows[rowIndex]![index]!;
    const volatile = raw.startsWith('~') && raw.length > 1;
    return {
        label: volatile ? raw.slice(1) : raw,
        rect: { x: rect.x / scale, y: rect.y / scale, width: rect.width / scale, height: rect.height / scale },
        ...(volatile ? { volatile: true } : {}),
    };
}));

const folder = path.join(fileURLToPath(KEYBOARD_DIR), values.set);
await mkdir(folder, { recursive: true });
const jsonPath = path.join(folder, 'keyboard.json');
const existing = await readFile(jsonPath, 'utf8').then((text) => JSON.parse(text) as KeyboardReferenceFile, () => undefined);
if (existing && (existing.width !== info.width || existing.height !== info.height || existing.top !== found.top || existing.bottom !== found.bottom)) {
    throw new Error(`This keyboard (${info.width}x${info.height}, rows ${found.top}..${found.bottom}) is not the one in ${values.set} `
        + `(${existing.width}x${existing.height}, rows ${existing.top}..${existing.bottom}): use another --set`);
}
const reference: KeyboardReferenceFile = existing ?? { name: values.set, width: info.width, height: info.height, scale, top: found.top, bottom: found.bottom, layers: [] };
reference.layers = [...reference.layers.filter((layer) => layer.name !== values.layer), { name: values.layer, keys }];
await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .extract({ left: 0, top: found.top, width: info.width, height: found.bottom - found.top + 1 }).greyscale().png()
    .toFile(path.join(folder, `${values.layer}.png`));
await writeFile(jsonPath, `${JSON.stringify(reference, null, 2)}\n`);
console.log(`Wrote ${values.set}/${values.layer} (${keys.length} keys, ${keys.filter((key) => key.volatile).length} left out of the comparison)`);
