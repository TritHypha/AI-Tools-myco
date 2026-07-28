// Main-thread owner for the isolated regex worker. Each operation has a hard
// deadline. A timeout destroys the worker; no later input is treated as checked.
import { Worker } from "node:worker_threads";

export interface RegexScanResult {
  hits: Array<{ col: number; length: number }>;
  lineTruncated: boolean;
  hitLimitReached: boolean;
  timedOut: boolean;
}

interface ScanResponse {
  id: number;
  hits: Array<{ col: number; length: number }>;
  lineTruncated: boolean;
  hitLimitReached: boolean;
}

export class RegexExecutor {
  private readonly worker: Worker;
  private nextId = 1;
  private stopped = false;

  constructor(pattern: string, flags: string) {
    const workerUrl = new URL("./regex-worker.js", import.meta.url);
    this.worker = new Worker(workerUrl, {
      workerData: { pattern, flags },
    });
  }

  scan(
    line: string,
    maxLineLength: number,
    maxHits: number,
    timeoutMs: number,
  ): Promise<RegexScanResult> {
    if (this.stopped) {
      return Promise.resolve({
        hits: [],
        lineTruncated: false,
        hitLimitReached: false,
        timedOut: true,
      });
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: RegexScanResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.worker.off("message", onMessage);
        this.worker.off("error", onError);
        resolve(result);
      };
      const onMessage = (message: ScanResponse): void => {
        if (message.id !== id) return;
        finish({ ...message, timedOut: false });
      };
      const onError = (): void => {
        this.stopped = true;
        finish({
          hits: [],
          lineTruncated: false,
          hitLimitReached: false,
          timedOut: true,
        });
      };
      const timer = setTimeout(() => {
        this.stopped = true;
        void this.worker.terminate();
        finish({
          hits: [],
          lineTruncated: line.length > maxLineLength,
          hitLimitReached: false,
          timedOut: true,
        });
      }, Math.max(1, timeoutMs));

      this.worker.on("message", onMessage);
      this.worker.once("error", onError);
      this.worker.postMessage({ id, line, maxLineLength, maxHits });
    });
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.worker.terminate();
  }
}
