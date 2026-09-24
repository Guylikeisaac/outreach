// In-page final confirmation panel (shadow DOM, so LinkedIn styles can't leak in or out).
// This is the last gate before a connection request is submitted: nothing is sent unless the user
// clicks "Send request" here or LinkedIn's own Send button.

export interface OverlayOptions {
  mode: 'confirm' | 'manual';
  name: string;
  getMessage: () => string;
  maxLength: number | null;
  info?: string;
  onSend?: () => void;
  onDone?: () => void; // manual mode: "I've sent it"
  onCancel: () => void;
}

const HOST_ID = 'syncup-outreach-overlay';

const CSS = `
  :host { all: initial; }
  .panel { position: fixed; left: 24px; bottom: 24px; width: 360px; z-index: 2147483647;
    background: #0c0c0e; color: #f4f4f5; border: 1px solid #2a2a2f; border-radius: 16px;
    box-shadow: 0 24px 60px rgba(0,0,0,.55); font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
    overflow: hidden; animation: in .18s ease-out; }
  @keyframes in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  .head { padding: 14px 16px 10px; border-bottom: 1px solid #1f1f23; }
  .brand { font-size: 10px; letter-spacing: .22em; font-weight: 700; color: #d4af6a; }
  .title { font-size: 15px; font-weight: 600; margin-top: 4px; }
  .sub { color: #a1a1aa; font-size: 12px; }
  .body { padding: 12px 16px; }
  .msg { white-space: pre-wrap; background: #141417; border: 1px solid #232327; border-radius: 10px; padding: 10px 12px;
    max-height: 190px; overflow: auto; }
  .meta { display: flex; justify-content: space-between; color: #71717a; font-size: 11px; margin-top: 6px; }
  .over { color: #f87171; }
  .info { margin-top: 8px; color: #fbbf24; font-size: 12px; }
  .actions { display: flex; gap: 8px; padding: 0 16px 16px; }
  button { all: unset; box-sizing: border-box; cursor: pointer; text-align: center; border-radius: 10px; padding: 9px 12px;
    font-weight: 600; font-size: 12px; letter-spacing: .04em; flex: 1; }
  .primary { background: linear-gradient(180deg, #e6c98f, #c9a45c); color: #0b0b0c; }
  .primary:hover { filter: brightness(1.06); }
  .ghost { border: 1px solid #2f2f35; color: #d4d4d8; }
  .ghost:hover { background: #17171a; }
  button[disabled] { opacity: .45; cursor: not-allowed; }
`;

export function removeOverlay() {
  document.getElementById(HOST_ID)?.remove();
}

export function showOverlay(opts: OverlayOptions): { refresh: () => void; setInfo: (s: string) => void; remove: () => void } {
  removeOverlay();
  const host = document.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>${CSS}</style>
    <div class="panel" role="dialog" aria-label="SyncUp final confirmation">
      <div class="head">
        <div class="brand">SYNCUP OUTREACH</div>
        <div class="title"></div>
        <div class="sub"></div>
      </div>
      <div class="body">
        <div class="msg"></div>
        <div class="meta"><span class="hint"></span><span class="count"></span></div>
        <div class="info"></div>
      </div>
      <div class="actions">
        <button class="ghost cancel">Cancel</button>
        <button class="ghost copy" hidden>Copy message</button>
        <button class="primary go"></button>
      </div>
    </div>`;
  const $ = <T extends Element>(sel: string) => root.querySelector(sel) as T;
  $('.title').textContent = opts.mode === 'confirm' ? `Send request to ${opts.name}?` : `Finish ${opts.name}'s request manually`;
  $('.sub').textContent =
    opts.mode === 'confirm'
      ? 'Your approved note is in LinkedIn’s invitation box. Confirm to submit.'
      : 'SyncUp stopped before sending. Complete the request in LinkedIn yourself.';
  $('.hint').textContent = opts.mode === 'confirm' ? 'Final check — this is what will be sent' : 'Approved message';
  const go = $<HTMLButtonElement>('.go');
  go.textContent = opts.mode === 'confirm' ? 'Send request' : "I've sent it";
  const copy = $<HTMLButtonElement>('.copy');
  if (opts.mode === 'manual') {
    copy.hidden = false;
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(opts.getMessage());
        copy.textContent = 'Copied';
      } catch {
        copy.textContent = 'Copy failed';
      }
    });
  }

  const refresh = () => {
    const msg = opts.getMessage();
    $('.msg').textContent = msg || '(note is empty)';
    const count = $('.count');
    count.textContent = opts.maxLength ? `${msg.length}/${opts.maxLength}` : `${msg.length} chars`;
    const over = opts.maxLength !== null && msg.length > opts.maxLength;
    count.className = `count${over ? ' over' : ''}`;
    if (opts.mode === 'confirm') go.disabled = !msg.trim() || over;
  };
  const setInfo = (s: string) => ($('.info').textContent = s);
  setInfo(opts.info ?? '');
  refresh();

  let busy = false;
  go.addEventListener('click', () => {
    if (busy || go.disabled) return;
    busy = true;
    go.disabled = true;
    (opts.mode === 'confirm' ? opts.onSend : opts.onDone)?.();
  });
  $('.cancel').addEventListener('click', () => opts.onCancel());

  document.documentElement.appendChild(host);
  return { refresh, setInfo, remove: () => host.remove() };
}
