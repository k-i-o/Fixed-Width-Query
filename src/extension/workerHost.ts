/**
 * Thin wrapper around a single worker thread.
 *
 * One worker per task rather than a shared pool: a task here is long (a full file scan),
 * cancellation is implemented by termination, and a pool would mainly add the ability to
 * leak a stuck worker. Parallel partitioned scans are a later change, once the scan is
 * shown to be CPU-bound rather than IO-bound.
 */

import { Worker } from 'node:worker_threads';

export interface WorkerTaskOptions {
  readonly scriptPath: string;
  readonly workerData: unknown;
  readonly heapMb: number;
}

export class WorkerTask<TMessage> {
  private worker: Worker | null = null;
  private terminated = false;

  constructor(
    private readonly options: WorkerTaskOptions,
    private readonly onMessage: (message: TMessage) => void,
    private readonly onError: (error: Error) => void,
  ) {}

  start(): void {
    const worker = new Worker(this.options.scriptPath, {
      workerData: this.options.workerData,
      // A worker that blows its heap dies alone. Without this, an unbounded allocation in
      // a scan takes down the extension host and every editor in the window with it.
      resourceLimits: { maxOldGenerationSizeMb: this.options.heapMb },
    });

    worker.on('message', (message: TMessage) => {
      if (!this.terminated) {
        this.onMessage(message);
      }
    });

    worker.on('error', (error: Error) => {
      if (!this.terminated) {
        this.onError(error);
      }
    });

    worker.on('exit', (code: number) => {
      // Code 1 after an explicit terminate() is normal; only report unexpected exits.
      if (!this.terminated && code !== 0) {
        this.onError(new Error(`Worker stopped unexpectedly with exit code ${code}.`));
      }
      this.worker = null;
    });

    this.worker = worker;
  }

  get isRunning(): boolean {
    return this.worker !== null && !this.terminated;
  }

  terminate(): void {
    this.terminated = true;
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      void worker.terminate();
    }
  }
}
