export function concurrencyLimits() {
  const limit = (name: string, fallback: number, maximum: number) => {
    const value = Number(process.env[name] || fallback);
    return Number.isInteger(value) && value >= 1 && value <= maximum ? value : fallback;
  };
  return {
    image: limit('MANJU_IMAGE_CONCURRENCY', 100, 165),
    video: limit('MANJU_VIDEO_CONCURRENCY', 100, 100),
    text: limit('MANJU_TEXT_CONCURRENCY', 20, 20),
  };
}

/** FIFO permits also bound legacy direct image calls outside the job queue. */
class AdapterPool {
  private running = 0;
  private waiting: Array<{ resolve: (release: () => void) => void; cleanup: () => void }> = [];

  constructor(private lane: 'text' | 'image') {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const entry = { resolve, cleanup: () => signal?.removeEventListener('abort', cancel) };
      const cancel = () => {
        this.waiting = this.waiting.filter(item => item !== entry);
        entry.cleanup();
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', cancel, { once: true });
      this.waiting.push(entry);
      this.drain();
    });
  }

  private drain(): void {
    while (this.running < concurrencyLimits()[this.lane] && this.waiting.length) {
      const entry = this.waiting.shift()!;
      entry.cleanup();
      this.running++;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.running--;
        this.drain();
      });
    }
  }
}

export const textPool = new AdapterPool('text');
export const imagePool = new AdapterPool('image');
