import { Writable } from 'node:stream';

// An MCP stdio server owns stdout: any stray console.log there (the shared
// TikTok helpers log every tap) would corrupt the protocol. Import this module
// FIRST: it keeps a private handle on the real stdout for the MCP transport
// and sends everything else written to stdout to stderr instead.
const writeToRealStdout = process.stdout.write.bind(process.stdout);

process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

export const protocolStdout = new Writable({
    write(chunk, encoding, callback) {
        writeToRealStdout(chunk, encoding, callback);
    },
});
