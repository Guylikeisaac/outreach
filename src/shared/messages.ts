// Typed message contracts between UI ⇄ background ⇄ content script.

import type { Campaign, ConnectionStatus, OutreachStatus, RawPost, Settings } from './types';

// ── UI → background ─────────────────────────────────────────────────────────────────────────
export type UiRequest =
  | { type: 'SAVE_CAMPAIGN'; campaign: Omit<Campaign, 'id' | 'createdAt' | 'updatedAt'> & { id?: string } }
  | { type: 'DELETE_CAMPAIGN'; campaignId: string }
  | { type: 'SET_ACTIVE_CAMPAIGN'; campaignId: string }
  | { type: 'START_DISCOVERY'; campaignId: string }
  | { type: 'START_AUTOPILOT'; campaignId: string }
  | { type: 'SCAN_CURRENT_TAB'; campaignId: string }
  | { type: 'STOP_DISCOVERY' }
  | { type: 'CHECK_CONNECTION'; prospectId: string }
  | { type: 'GENERATE_MESSAGE'; prospectId: string }
  | { type: 'SAVE_MESSAGE'; prospectId: string; message: string }
  | { type: 'APPROVE_AND_CONNECT'; prospectId: string; message: string }
  | { type: 'CANCEL_WORKFLOW' }
  | { type: 'SET_OUTREACH_STATUS'; prospectId: string; status: OutreachStatus }
  | { type: 'OPEN_URL'; url: string }
  | { type: 'SAVE_SETTINGS'; settings: Partial<Settings> }
  | { type: 'SYNC_NOW' }
  | { type: 'CLEAR_ERROR' };

export type UiResponse<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };

// ── background → content script ─────────────────────────────────────────────────────────────
export type ContentRequest =
  | { type: 'PING' }
  | { type: 'SCAN_POSTS'; maxPosts: number; scroll: boolean }
  | { type: 'DETECT_CONNECTION'; expectedName: string }
  | { type: 'PREPARE_CONNECT'; prospectId: string; expectedName: string; message: string }
  /** Autopilot: connect → add note → write message → send → verify pending (user enabled Autopilot). */
  | { type: 'AUTO_CONNECT'; expectedName: string; message: string }
  /** Autopilot: message an existing 1st-degree connection from their profile. */
  | { type: 'AUTO_MESSAGE'; expectedName: string; message: string };

export interface PingResponse {
  ok: true;
  url: string;
  page: 'search' | 'feed' | 'profile' | 'post' | 'auth' | 'checkpoint' | 'other';
}

export type ScanResponse = { ok: true; posts: RawPost[]; truncated: boolean } | { ok: false; error: string; diagnostics?: string };

export type DetectResponse =
  | {
      ok: true;
      status: ConnectionStatus;
      canonicalUrl: string;
      name: string;
      headline: string;
      via: string;
    }
  | { ok: false; error: string; status: 'UNKNOWN'; diagnostics?: string };

export type PrepareResponse =
  | { ok: true; stage: 'awaiting_confirmation'; noteMaxLength: number | null }
  | {
      ok: false;
      stage: 'status_changed' | 'identity_mismatch' | 'no_connect' | 'no_dialog' | 'no_note' | 'too_long' | 'structure' | 'extra_verification';
      status?: ConnectionStatus;
      error: string;
      diagnostics?: string;
    };

export type AutoMessageResponse =
  | { ok: true; verified: boolean }
  | { ok: false; error: string; stage: 'structure' | 'identity_mismatch' | 'no_message_button' | 'no_composer'; diagnostics?: string };

export type AutoConnectResponse =
  | { ok: true; verified: boolean; sentMessage: string }
  | Extract<PrepareResponse, { ok: false }>;

// ── content script → background (unsolicited) ───────────────────────────────────────────────
export type ContentEvent =
  | { type: 'SCAN_PROGRESS'; found: number }
  | {
      type: 'WORKFLOW_EVENT';
      prospectId: string;
      event: 'submitted' | 'cancelled' | 'failed';
      verified: boolean;
      detail: string;
      finalMessage?: string;
    };

export const PAGE_STRUCTURE_ERROR = 'LinkedIn page structure changed or element could not be identified.';
