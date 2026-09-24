import { useEffect, useState } from 'react';
import type { UiRequest, UiResponse } from '@shared/messages';
import { DEFAULTS, get, type StoreKey, type StoreShape } from '@shared/storage';

/** Live view of one storage key; re-renders whenever the background worker writes it. */
export function useStore<K extends StoreKey>(key: K): StoreShape[K] {
  const [value, setValue] = useState<StoreShape[K]>(() => structuredClone(DEFAULTS[key]));
  useEffect(() => {
    let alive = true;
    get(key).then((v) => alive && setValue(v));
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && key in changes) get(key).then((v) => alive && setValue(v));
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, [key]);
  return value;
}

export async function send<T = unknown>(req: UiRequest): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as UiResponse<T> | undefined;
  if (!res) throw new Error('The SyncUp background worker did not respond. Try again.');
  if (!res.ok) throw new Error(res.error);
  return res.data as T;
}

/** Keeps a port open to the worker while the dashboard is visible (keeps long runs alive). */
export function useWorkerHeartbeat() {
  useEffect(() => {
    let port: chrome.runtime.Port | null = null;
    const connect = () => {
      port = chrome.runtime.connect({ name: 'syncup-ui' });
      port.onDisconnect.addListener(() => {
        port = null;
      });
    };
    connect();
    const timer = setInterval(() => {
      if (!port) connect();
      try {
        port?.postMessage('ping');
      } catch {
        port = null;
      }
    }, 20000);
    return () => {
      clearInterval(timer);
      port?.disconnect();
    };
  }, []);
}

export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function relativeDay(iso: string): string {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
