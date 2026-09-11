import type { ToHost } from '../shared/protocol.js';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function post(message: ToHost): void {
  api.postMessage(message);
}

/**
 * Persisted state is deliberately tiny: scroll position and the query text, nothing that
 * could be re-read from the file. Restoring a tab must never mean restoring row data.
 */
export interface PersistedState {
  readonly firstRow?: number;
  readonly query?: string;
}

export function getState(): PersistedState {
  return (api.getState() as PersistedState | undefined) ?? {};
}

export function setState(state: PersistedState): void {
  api.setState(state);
}
