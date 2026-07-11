// binary.ts — cheap, general binary-file detection.
//
// myco is a text search tool; indexing binaries wastes space and produces junk
// terms. Rather than maintain an extension blocklist (which is always wrong for
// someone), we sniff content: a NUL byte in the first few KB is the same signal
// git and grep use to classify a file as binary.

const SNIFF_BYTES = 8000;

// True if the buffer looks like binary content (contains a NUL in the sniff
// window). Works on a Buffer we have already read for indexing, so it costs
// nothing extra.
export function looksBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
