// Core domain types shared by the background worker, content script, UI and backend sync.

export const TARGET_ROLES = [
  'Founders',
  'Co-founders',
  'Recruiters',
  'Talent Acquisition',
  'HR',
  'People Operations',
  'Hiring Managers',
  'CTOs',
  'Engineering Leaders',
  'Product Leaders',
] as const;
export type TargetRole = (typeof TARGET_ROLES)[number];

export const TARGET_LOCATIONS = [
  'India',
  'Bengaluru',
  'Mumbai',
  'Delhi NCR',
  'Hyderabad',
  'Pune',
  'Chennai',
  'Gurugram',
  'Noida',
] as const;
export type TargetLocation = (typeof TARGET_LOCATIONS)[number];

export interface Campaign {
  id: string;
  name: string;
  searchQueries: string[];
  targetRoles: TargetRole[];
  targetLocations: TargetLocation[];
  dailyTarget: number;
  /** Autopilot: after discovery, send connection requests with the note automatically. */
  autoSend?: boolean;
  /** Max connection requests Autopilot sends per day for this campaign. */
  dailySendLimit?: number;
  createdAt: string;
  updatedAt: string;
}

export type Qualification = 'HIGH' | 'MEDIUM' | 'LOW';
export type Tri = 'YES' | 'NO' | 'UNKNOWN';

export interface QualificationCheck {
  key: 'activeHiring' | 'india' | 'involvedInHiring' | 'decisionMaker' | 'roleRelevant' | 'recent';
  label: string;
  value: Tri;
  evidence?: string;
}

export interface QualificationResult {
  level: Qualification;
  /** Only HIGH/MEDIUM prospects may receive outreach. */
  eligible: boolean;
  persona: Persona | null;
  checks: QualificationCheck[];
  /** Human-readable reasons, e.g. "✓ Founder". */
  reasons: string[];
}

export type Persona =
  | 'Founder'
  | 'Co-founder'
  | 'Recruiter'
  | 'Talent Acquisition'
  | 'HR'
  | 'People Operations'
  | 'Hiring Manager'
  | 'CTO'
  | 'Engineering Leader'
  | 'Product Leader';

export type ConnectionStatus = 'CONNECTED' | 'PENDING' | 'CONNECT_AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';

/**
 * Outreach pipeline. The first block is the MVP; the rest is the future SyncUp pipeline.
 * Order matters: it is used for funnel analytics and to prevent moving backwards by accident.
 */
export const OUTREACH_STATUSES = [
  'NEW',
  'REVIEWED',
  'APPROVED',
  'REQUEST_SUBMITTED',
  'CONNECTED',
  'MESSAGE_SENT',
  'REPLIED',
  'INTERESTED',
  'JD_REQUESTED',
  'JD_RECEIVED',
  'CANDIDATES_SENT',
  'INTERVIEW',
  'HIRED',
  'SKIPPED',
] as const;
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

/** Raw data scraped from a LinkedIn post. Nothing here is inferred. */
export interface RawPost {
  postUrl: string;
  activityId: string;
  authorName: string;
  authorUrl: string;
  authorType: 'person' | 'company' | 'unknown';
  authorHeadline: string;
  /** "1st" | "2nd" | "3rd+" | "" as shown next to the author name. */
  authorDegree: string;
  relativeTime: string;
  postText: string;
  companyLinks: { name: string; url: string }[];
  mentionedPeople: { name: string; url: string }[];
}

export interface Prospect {
  id: string;
  /** Canonical (normalized) LinkedIn profile URL — the primary unique identifier. */
  profileUrl: string;
  /** Other URLs seen for the same person (e.g. /in/ACoAA… ids that later redirect). */
  profileAliases: string[];
  name: string;
  firstName: string;
  headline: string;
  company: string;
  companyUrl: string;
  hiringRole: string;
  location: string;
  postUrl: string;
  postText: string;
  postedDate: string; // ISO date or ''
  source: 'LinkedIn hiring post';
  contactSource: 'post_author' | 'mentioned_in_post';
  qualification: QualificationResult;
  connectionStatus: ConnectionStatus;
  connectionCheckedAt: string | null;
  outreachStatus: OutreachStatus;
  message: string;
  /** When the connection request was submitted (used for daily send limits). */
  requestSentAt?: string | null;
  /** When a direct message was sent to an existing connection. */
  messageSentAt?: string | null;
  /** True when the user skipped this prospect themselves (Autopilot never contacts them). */
  skippedByUser?: boolean;
  /** Direct message couldn't be sent (no Message button / profile mismatch) — don't retry automatically. */
  dmUnavailable?: boolean;
  campaignId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityLog {
  id: string;
  prospectId: string | null;
  campaignId: string | null;
  action: string;
  level: 'info' | 'success' | 'warn' | 'error';
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Settings {
  supabaseUrl: string;
  supabaseAnonKey: string;
  anthropicApiKey: string;
  /** Connection note template; {first_name} and {hiring_line} are filled per prospect. */
  messageTemplate: string;
  useAiPersonalization: boolean;
  /** Max posts to scroll through per search query per run. */
  maxPostsPerQuery: number;
}

export type RunPhase = 'idle' | 'running' | 'stopping' | 'error';

export interface RunState {
  phase: RunPhase;
  campaignId: string | null;
  currentQuery: string;
  scanned: number;
  added: number;
  message: string;
  /** Set when a LinkedIn operation failed safely and can be retried. */
  lastError: string | null;
  /** Page-structure summary captured when a scan fails, for fixing selectors. */
  diagnostics?: string | null;
  updatedAt: string;
}

export interface WorkflowState {
  prospectId: string | null;
  step:
    | 'idle'
    | 'checking_connection'
    | 'opening_profile'
    | 'awaiting_final_confirmation'
    | 'submitting'
    | 'done'
    | 'stopped';
  detail: string;
  diagnostics?: string | null;
  updatedAt: string;
}
