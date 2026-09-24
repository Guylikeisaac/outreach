// The "work tab": a single LinkedIn tab the extension drives, visible to the user at all times.

import type { ContentRequest, PingResponse } from '@shared/messages';
import { isLinkedInUrl } from '@shared/linkedin';

const WORK_TAB_KEY = 'workTabId';

async function storedTabId(): Promise<number | null> {
  const r = await chrome.storage.session.get(WORK_TAB_KEY);
  return typeof r[WORK_TAB_KEY] === 'number' ? (r[WORK_TAB_KEY] as number) : null;
}

async function existingTab(): Promise<chrome.tabs.Tab | null> {
  const id = await storedTabId();
  if (id === null) return null;
  try {
    const tab = await chrome.tabs.get(id);
    return tab && isLinkedInUrl(tab.url ?? tab.pendingUrl) ? tab : null;
  } catch {
    return null;
  }
}

function waitForComplete(tabId: number, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('LinkedIn took too long to load.'));
    }, timeoutMs);
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** Navigates the work tab (creating it if needed) to a LinkedIn URL and waits for the content script. */
export async function openInWorkTab(url: string, focus = true): Promise<number> {
  if (!isLinkedInUrl(url)) throw new Error('Refusing to navigate outside www.linkedin.com.');
  let tab = await existingTab();
  if (tab?.id !== undefined) {
    const loaded = waitForComplete(tab.id);
    await chrome.tabs.update(tab.id, { url, active: focus });
    await loaded;
  } else {
    tab = await chrome.tabs.create({ url, active: focus });
    await chrome.storage.session.set({ [WORK_TAB_KEY]: tab.id });
    await waitForComplete(tab.id!);
  }
  if (focus && tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  await waitForContentScript(tab.id!);
  return tab.id!;
}

export async function useTabAsWorkTab(tabId: number) {
  await chrome.storage.session.set({ [WORK_TAB_KEY]: tabId });
}

export async function waitForContentScript(tabId: number, timeoutMs = 12000): Promise<PingResponse> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const res = (await chrome.tabs.sendMessage(tabId, { type: 'PING' } satisfies ContentRequest)) as PingResponse;
      if (res?.ok) return res;
    } catch {
      /* not injected yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('SyncUp could not attach to the LinkedIn page. Reload the tab and retry.');
}

export async function sendToTab<T>(tabId: number, req: ContentRequest): Promise<T> {
  return (await chrome.tabs.sendMessage(tabId, req)) as T;
}

export async function activeLinkedInTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab && isLinkedInUrl(tab.url) ? tab : null;
}
