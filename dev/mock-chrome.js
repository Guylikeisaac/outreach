// Dev-only: a minimal in-memory `chrome` stub so the dashboard can be previewed in a normal tab
// (`npm run preview:ui`). Never shipped in the extension build.
(() => {
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const cid = 'c1';
  const q = (level, reasons, persona) => ({ level, eligible: level !== 'LOW', persona, checks: [], reasons });
  const mk = (id, o) => ({
    id, profileAliases: [], source: 'LinkedIn hiring post', contactSource: 'post_author', campaignId: cid,
    postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:1/', companyUrl: '', message: '',
    connectionCheckedAt: null, createdAt: iso(3600e3), updatedAt: iso(3600e3), postText: o.postText || '', ...o,
  });
  const prospects = {
    p1: mk('p1', { name: 'Rahul Sharma', firstName: 'Rahul', profileUrl: 'https://www.linkedin.com/in/rahul/', headline: 'Founder @ Example AI | Ex-Flipkart', company: 'Example AI', hiringRole: 'Senior Backend Engineer', location: 'Bengaluru', postedDate: iso(2*864e5).slice(0,10), qualification: q('HIGH', ['✓ Active hiring', '✓ Bengaluru', '✓ Posted the hiring announcement', '✓ Founder', '✓ Hiring Senior Backend Engineer', '✓ Posted recently (2d ago)'], 'Founder'), connectionStatus: 'CONNECT_AVAILABLE', outreachStatus: 'REVIEWED', message: "Rahul, not selling anything 😄\nSaw you're hiring a Senior Backend Engineer.\nWe’re building SyncUp, India’s own LinkedIn.\nEarly days, so everything’s free.\nIf you’re hiring, share a JD and support us while we build for India!\nWe’ll send pre-screened candidates.", postText: "We're hiring a Senior Backend Engineer in Bengaluru! DM me." }),
    p2: mk('p2', { name: 'Priya Nair', firstName: 'Priya', profileUrl: 'https://www.linkedin.com/in/priya/', headline: 'Talent Acquisition Lead at Zeta', company: 'Zeta', hiringRole: 'Product Designer', location: 'Pune', postedDate: iso(864e5).slice(0,10), qualification: q('HIGH', ['✓ Active hiring', '✓ Pune', '✓ Talent Acquisition', '✓ Talent Acquisition', '✓ Hiring Product Designer', '✓ Posted recently (1d ago)'], 'Talent Acquisition'), connectionStatus: 'UNKNOWN', outreachStatus: 'NEW' }),
    p3: mk('p3', { name: 'Arjun Mehta', firstName: 'Arjun', profileUrl: 'https://www.linkedin.com/in/arjun/', headline: 'Engineering Manager, Payments', company: '', hiringRole: '', location: 'India', postedDate: '', qualification: q('MEDIUM', ['✓ Active hiring', '✓ India', '✓ Posted the hiring announcement', '✓ Engineering Leader', '? Role not stated', '? Post date unclear'], 'Engineering Leader'), connectionStatus: 'PENDING', outreachStatus: 'SKIPPED' }),
    p4: mk('p4', { name: 'Neha Gupta', firstName: 'Neha', profileUrl: 'https://www.linkedin.com/in/neha/', headline: 'Co-founder & CTO, Stackly', company: 'Stackly', hiringRole: 'SDE-2', location: 'Hyderabad', postedDate: iso(3*864e5).slice(0,10), qualification: q('HIGH', ['✓ Active hiring', '✓ Hyderabad', '✓ Posted the hiring announcement', '✓ Co-founder', '✓ Hiring SDE-2', '✓ Posted recently (3d ago)'], 'Co-founder'), connectionStatus: 'PENDING', outreachStatus: 'REQUEST_SUBMITTED' }),
  };
  const logs = [
    ['Discovery started — 2 search(es)', 'info'], ['Searching LinkedIn: “startup hiring India”', 'info'], ['Found hiring post', 'info', 'p1'],
    ['Identified Rahul Sharma — Founder @ Example AI', 'info', 'p1'], ['Qualification: HIGH', 'success', 'p1'], ['Message generated', 'info', 'p1'],
    ['User approved outreach', 'success', 'p4'], ['Connection workflow opened', 'info', 'p4'], ['Connection request submitted to Neha Gupta', 'success', 'p4'],
    ['Arjun Mehta: Connection already pending', 'info', 'p3'], ['Scanned 25 posts: 4 new, 2 already known, 17 not hiring, 2 without a clear contact', 'info'],
  ].map(([action, level, prospectId], i) => ({ id: 'l' + i, action, level, prospectId: prospectId || null, campaignId: cid, metadata: {}, createdAt: iso((20 - i) * 60e3) }));
  const store = {
    campaigns: { [cid]: { id: cid, name: 'Indian Startup Hiring', searchQueries: ['startup hiring India', 'founder hiring India'], targetRoles: ['Founders', 'Co-founders', 'Recruiters', 'Talent Acquisition', 'HR', 'Hiring Managers', 'CTOs'], targetLocations: ['India'], dailyTarget: 20, createdAt: iso(864e5), updatedAt: iso(864e5) } },
    activeCampaignId: cid, prospects, logs,
    runState: { phase: 'running', campaignId: cid, currentQuery: 'founder hiring India', scanned: 25, added: 4, message: 'Reading posts…', lastError: null, updatedAt: iso(0) },
    workflow: { prospectId: 'p4', step: 'done', detail: 'Request submitted and verified as pending.', updatedAt: iso(0) },
    stats: { [cid]: { postsScanned: 50, hiringPosts: 21 } },
  };
  const listeners = [];
  window.chrome = {
    storage: {
      local: {
        get: async (k) => ({ [k]: structuredClone(store[k]) }),
        set: async (o) => { Object.assign(store, o); listeners.forEach((l) => l(Object.fromEntries(Object.keys(o).map((k) => [k, { newValue: o[k] }])), 'local')); },
      },
      onChanged: { addListener: (l) => listeners.push(l), removeListener: () => {} },
    },
    runtime: {
      sendMessage: async (m) => { console.log('[mock] sendMessage', m); return m.type === 'GENERATE_MESSAGE' ? { ok: true, data: prospects.p1.message } : { ok: true }; },
      connect: () => ({ postMessage() {}, disconnect() {}, onDisconnect: { addListener() {} } }),
    },
  };
})();
