/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Only what this project needs: find the chart page, evaluate an expression in it,
 * read the result. One connection per call - the bridge is called at human rates,
 * and a persistent socket would need reconnection logic for no benefit.
 */
import { CHART_URL_MATCH } from './page-shim.ts';

export interface Target {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface CdpOptions {
  port: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** The debug endpoint is absent whenever TradingView is not running: that is a normal state. */
async function listTargets(port: number): Promise<Target[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(3_000),
    });
    const parsed: unknown = await res.json();
    return Array.isArray(parsed) ? (parsed as Target[]) : [];
  } catch {
    return [];
  }
}

/** The chart page we can drive, or `null` when TradingView is not running with a debug port. */
export async function findChartTarget(port: number): Promise<Target | null> {
  for (const target of await listTargets(port)) {
    if (target.type === 'page' && target.url.includes(CHART_URL_MATCH)) return target;
  }
  return null;
}

interface CdpReply {
  id?: number;
  result?: {
    result?: { value?: unknown };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  };
}

/**
 * Evaluate `expression` in the chart page and return its (JSON-serialisable) value.
 *
 * Rejects when the page is missing, throws, or does not answer in time - callers
 * turn that into an HTTP 502 rather than hanging.
 */
export async function evaluate<T>(options: CdpOptions, expression: string): Promise<T> {
  const target = await findChartTarget(options.port);
  if (!target) {
    throw new Error(`no TradingView chart page on 127.0.0.1:${options.port}`);
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const { promise, resolve, reject } = Promise.withResolvers<CdpReply>();
    const timer = setTimeout(() => reject(new Error(`CDP evaluate timed out after ${timeoutMs}ms`)), timeoutMs);
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression,
            returnByValue: true,
            awaitPromise: true,
            userGesture: true,
          },
        }),
      );
    };
    socket.onmessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as CdpReply;
      if (message.id !== 1) return;
      clearTimeout(timer);
      resolve(message);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error('CDP socket error'));
    };

    const reply = await promise;

    const thrown = reply.result?.exceptionDetails;
    if (thrown) {
      throw new Error(thrown.exception?.description ?? thrown.text ?? 'page exception');
    }
    return reply.result?.result?.value as T;
  } finally {
    socket.close();
  }
}
