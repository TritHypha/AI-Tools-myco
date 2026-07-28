// Isolated JavaScript RegExp execution. This file intentionally remains plain
// JavaScript so source-mode tests and the compiled package can start it without
// a TypeScript loader. tsc copies it to dist via allowJs.
import { parentPort, workerData } from "node:worker_threads";

const port = parentPort;
if (port === null) throw new Error("regex worker requires parentPort");

const matcher = new RegExp(workerData.pattern, workerData.flags);

port.on("message", (request) => {
  const hay =
    request.line.length > request.maxLineLength
      ? request.line.slice(0, request.maxLineLength)
      : request.line;
  const hits = [];
  let hitLimitReached = false;
  matcher.lastIndex = 0;

  let match;
  while ((match = matcher.exec(hay)) !== null) {
    if (hits.length >= request.maxHits) {
      hitLimitReached = true;
      break;
    }
    hits.push({ col: match.index + 1, length: match[0].length });
    if (match[0].length === 0) matcher.lastIndex++;
  }

  port.postMessage({
    id: request.id,
    hits,
    lineTruncated: request.line.length > request.maxLineLength,
    hitLimitReached,
  });
});
