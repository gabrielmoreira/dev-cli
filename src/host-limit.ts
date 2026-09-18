import { AsyncLocalStorage } from "node:async_hooks";
import pLimit, { type LimitFunction } from "p-limit";

export const HOST_CONCURRENCY = 5;

const limits = new Map<string, LimitFunction>();
const acquiredHosts = new AsyncLocalStorage<ReadonlySet<string>>();

function sourceHost(source: string | URL): string | undefined {
  if (source instanceof URL) return source.host.toLowerCase() || undefined;

  const value = source.trim();
  if (/^(?:[a-zA-Z]:[\\/]|\.{0,2}[\\/])/.test(value)) return undefined;

  try {
    return new URL(value).host.toLowerCase() || undefined;
  } catch {
    const scp = value.match(/^(?:[^@\s/:]+@)?([^:/\s]+):.+$/);
    return scp?.[1]?.toLowerCase();
  }
}

function getLimit(host: string): LimitFunction {
  let limit = limits.get(host);
  if (!limit) {
    limit = pLimit(HOST_CONCURRENCY);
    limits.set(host, limit);
  }
  return limit;
}

export function withHostLimit<T>(source: string | URL, operation: () => Promise<T>): Promise<T> {
  const host = sourceHost(source);
  if (!host) return Promise.resolve().then(operation);

  const currentHosts = acquiredHosts.getStore();
  if (currentHosts?.has(host)) return Promise.resolve().then(operation);

  return getLimit(host)(() => {
    const nestedHosts = new Set(currentHosts);
    nestedHosts.add(host);
    return acquiredHosts.run(nestedHosts, operation);
  });
}
