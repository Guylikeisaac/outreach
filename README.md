# SyncUp Outreach

**Find hiring teams. Start conversations.**

A Chrome/Chromium extension (Manifest V3; React + TypeScript + Vite + Tailwind) that finds people actively hiring in India on LinkedIn, qualifies them, drafts a personalized SyncUp note, and helps you send the connection request. Nothing is sent until you approve the message and then confirm the send on LinkedIn.

```
Campaign → Search → Hiring post → Extract → Identify hiring person → Qualify
        → Check connection → Generate message → YOU review/edit → Approve
        → Profile → Connect → Add a note → message inserted → YOU confirm send
        → Verified "Pending" → Saved + logged → never processed again
```

## Install

```bash
npm install
npm run build          # → dist/
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `dist/` folder.
3. Pin **SyncUp Outreach**. Clicking the icon opens the dashboard in Chrome's side panel.
4. Sign in to LinkedIn in the same browser. The extension never handles your credentials.

On first install the extension creates the **Indian Startup Hiring** campaign (`startup hiring India`, target: India, 20/day).

## Using it

| Step | Where | What happens |
|---|---|---|
| Configure | **Discover** | Set the name, search queries, target people, geography, and daily target. |
| START DISCOVERY | **Discover** | Opens one visible LinkedIn tab and searches posts (past week, newest first) for each query. It scrolls at a human pace, then extracts, qualifies, and dedupes each post. It stops at the daily target. **SCAN TAB** scans whatever search or feed page you already have open. |
| Review leads | **Prospects** | Cards show the name, headline, role, location, a HIGH/MEDIUM/LOW rating with ✓/✗/? reasons, and the connection and outreach status. |
| CHECK CONNECTION | card | Opens the profile and reads the status from the profile's top card only: `CONNECTED`, `PENDING`, `CONNECT_AVAILABLE`, `UNAVAILABLE` or `UNKNOWN`. Connected and pending prospects are skipped. |
| GENERATE MESSAGE | card | Only for qualified (HIGH/MEDIUM) prospects with `CONNECT_AVAILABLE`. |
| EDIT / APPROVE & CONTINUE | review sheet | Approval is the only way into the connection workflow. |
| Final confirm | LinkedIn page | SyncUp clicks Connect → Add a note, inserts the note, and shows a **SyncUp confirmation panel**. The request goes out only when you click **Send request** there (or LinkedIn's own Send). SyncUp then checks that LinkedIn shows "Pending" before it records `REQUEST_SUBMITTED`. |
| Track | **Pipeline** / card Status menu | Funnel: hiring posts → qualified → sent → connected → replied → JD → candidates → interview → hired. |
| Audit | **Activity** | A timestamped log of everything the extension did. |

## Safety model

- **Human in the loop, twice.** You approve in the dashboard and confirm again on LinkedIn. The background never submits anything silently.
- **No guessing.** Missing fields stay blank. Qualification reasons cite the text that produced them, and `UNKNOWN` means the evidence wasn't there.
- **Scoped DOM access.** Elements are found by aria-label, role, link target, or exact text, and clicked with `element.click()`. It never clicks by coordinates. Profile actions are searched only inside the top card whose `<h1>` matches the prospect's name, so "People also viewed" buttons can't be hit. It never clicks "Send without a note".
- **Fail safe.** If the page isn't recognized, the operation stops with *"LinkedIn page structure changed or element could not be identified."* and offers Retry. Other stops:
  - Profile mismatch: the prospect is skipped.
  - Connection status unknown: it doesn't proceed.
  - No note field, note limit reached, or email verification required: a panel with **Copy message** and **I've sent it** lets you finish by hand. SyncUp then checks that the request shows as pending.
- **No duplicates.** The normalized profile URL is the unique key, and alias URLs such as `/in/ACoAA…` are merged when their vanity URL is found. It also checks the shared Supabase history before adding a prospect. A prospect already at `REQUEST_SUBMITTED` or later can't be approved again, and the live profile status is re-read just before connecting.
- **Stays on LinkedIn.** The content script runs only on `www.linkedin.com`, and the worker refuses to navigate anywhere else. Sign-in walls and security checkpoints stop the run and ask you to handle them yourself.
- **Qualification gate.** LOW prospects can't have a message generated or approved.

## Qualification

| Check | YES when |
|---|---|
| Active hiring | First-person hiring statement ("we're hiring", "join our team", "open roles"…), or "hiring" plus a stated role or apply/CV cue. Job-seeker (#OpenToWork), layoff/commentary and pay-to-apply posts are rejected. |
| India | An Indian city, "India", ₹, or LPA appears. Foreign-only locations → NO. City-only campaigns must match a selected city. |
| Involved in hiring | Recruiter, TA, HR, or People persona; the author of a first-person hiring post; or someone the post explicitly names as the contact. |
| Decision maker | Headline persona (Founder, Co-founder, Recruiter, TA, HR, People Ops, Hiring Manager, CTO, Engineering or Product leader) that is among the campaign's target people. |
| Role / recency | Role extracted from the post; post within 14 days. Posts older than 45 days are rejected. |

**HIGH** = active + India + involved + decision maker. **MEDIUM** = active, not outside India, and two of those three signals. Anything else is **LOW**, which is shown for reference but can't be contacted.

If a company page posts and names nobody specific, it's skipped. The extension never picks a random employee.

## Message

```
Rahul, not selling anything 😄
Saw you're hiring a Senior Backend Engineer.   ← only if a role was extracted from the post
We’re building SyncUp, India’s own LinkedIn.
Early days, so everything’s free.
If you’re hiring, share a JD and support us while we build for India!
We’ll send pre-screened candidates.
```

The note is capped at 300 characters. The page's own limit is read before inserting, since some free accounts allow only 200. Optional **AI personalization** (Settings) asks Claude (`claude-opus-5`) for the "Saw you're hiring…" line. The reply is rejected, and the template line used, if it contains any word that isn't in the post.

## Backend (optional)

1. Run `supabase/schema.sql` in your Supabase project.
2. In **Settings**, enter the project URL and anon key, then click **Sync all**.

Prospects are upserted on `linkedin_profile_url`, and campaigns and activity logs are pushed too. Local storage stays the source of truth, and the sync retries from a queue. The sample RLS policies are open to the anon key; scope them to your team (Supabase Auth) before sharing widely.

## Architecture

```
src/
  shared/      pure, unit-tested domain logic + contracts
    types.ts           Campaign, Prospect, statuses (incl. future pipeline)
    extraction.ts      hiring signals, role, geography, persona, contact identification
    qualification.ts   HIGH/MEDIUM/LOW with evidence
    pipeline.ts        RawPost → Prospect
    message.ts         template + validation
    linkedin.ts        URL normalization, activity-id → date, search URL
    messages.ts        typed UI ⇄ worker ⇄ content-script protocol
    storage.ts         chrome.storage repository
    backend.ts         Supabase REST client
  background/  MV3 service worker (sole writer of state)
    discovery.ts  outreach.ts  tabs.ts  sync.ts  log.ts  ai.ts
  content/     LinkedIn content script (IIFE)
    scan.ts  profile.ts  overlay.ts  dom.ts
  ui/          React side-panel dashboard
supabase/schema.sql
```

Build outputs: `sidepanel.html` (Vite + React + Tailwind v4), `background.js` (one self-contained ES module; MV3 workers can't `import()`), and `content.js` (IIFE).

## Development

```bash
npm test             # vitest: extraction / qualification / message logic
npm run typecheck
npm run preview:ui   # dashboard with mocked chrome APIs + sample data (preview.html#prospects?w=380)
npm run build
```

After a rebuild, click ↻ on the extension in `chrome://extensions` and reload open LinkedIn tabs.

### When LinkedIn changes its markup

Every selector lives in `src/content/scan.ts` and `src/content/profile.ts`. Each lookup has a semantic primary (URNs, aria-labels) and a structural fallback. If both fail, the run stops with the page-structure error rather than guessing. Update the selectors there.

## Responsible use

LinkedIn's User Agreement restricts automated activity, and LinkedIn limits weekly invitations. Keep daily volumes modest, personalize, and stop if LinkedIn warns you. This tool is built to assist a person doing outreach by hand, not to replace them.
