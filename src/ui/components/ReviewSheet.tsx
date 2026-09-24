import { useEffect, useState } from 'react';
import type { Prospect } from '@shared/types';
import { LINKEDIN_NOTE_LIMIT, validateMessage } from '@shared/message';
import { send } from '../hooks';
import { Button, useAction, useToast } from './ui';

/** Message review — the only place outreach can be approved. */
export function ReviewSheet({ prospect: p, onClose }: { prospect: Prospect; onClose: () => void }) {
  const [message, setMessage] = useState(p.message);
  const [editing, setEditing] = useState(false);
  const { busy, run } = useAction();
  const toast = useToast();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const issues = validateMessage(message, p.firstName);
  const blocking = issues.some((i) => i.level === 'error');
  const role = [p.qualification.persona, p.company].filter(Boolean).join(' — ') || p.headline;

  const persist = () => run('save', () => send({ type: 'SAVE_MESSAGE', prospectId: p.id, message }));

  const approve = async () => {
    const ok = await run('approve', async () => {
      await send({ type: 'APPROVE_AND_CONNECT', prospectId: p.id, message });
      return true;
    });
    if (ok) {
      toast('Approved. Finish the request in the LinkedIn tab — nothing is sent until you confirm there.', 'ok');
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-label={`Review outreach to ${p.name}`}
        className="animate-rise max-h-[92vh] w-full max-w-lg overflow-auto rounded-t-3xl border border-line-2 bg-panel p-5 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="label-caps gold-text">SyncUp Outreach</div>
          <button className="text-dim hover:text-silver" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="mt-3 text-lg font-semibold">{p.name}</div>
        {role && <div className="text-xs text-muted">{role}</div>}
        {p.hiringRole && (
          <div className="mt-3">
            <div className="label-caps">Hiring</div>
            <div className="mt-0.5 text-sm text-silver">{p.hiringRole}</div>
          </div>
        )}

        <div className="my-4 h-px bg-line" />

        <div className="flex items-center justify-between">
          <div className="label-caps">Message</div>
          <div className={`text-[11px] tabular-nums ${message.length > LINKEDIN_NOTE_LIMIT ? 'text-bad' : 'text-dim'}`}>
            {message.length}/{LINKEDIN_NOTE_LIMIT}
          </div>
        </div>
        {editing ? (
          <textarea
            className="mt-2 h-52 w-full resize-none rounded-2xl border border-gold/40 bg-panel-2 p-3.5 text-sm leading-relaxed text-fg outline-none focus:ring-2 focus:ring-gold/15"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            autoFocus
          />
        ) : (
          <div className="mt-2 whitespace-pre-wrap rounded-2xl border border-line-2 bg-panel-2 p-3.5 text-sm leading-relaxed">{message}</div>
        )}

        {issues.length > 0 && (
          <ul className="mt-2 space-y-1 text-[11px]">
            {issues.map((i) => (
              <li key={i.text} className={i.level === 'error' ? 'text-bad' : 'text-warn/90'}>
                {i.level === 'error' ? '✗' : '!'} {i.text}
              </li>
            ))}
          </ul>
        )}

        <div className="my-4 h-px bg-line" />

        <div className="grid grid-cols-2 gap-2">
          <Button
            onClick={async () => {
              if (editing) await persist();
              setEditing((v) => !v);
            }}
            busy={busy === 'save'}
          >
            {editing ? 'DONE EDITING' : 'EDIT MESSAGE'}
          </Button>
          <Button variant="primary" onClick={approve} busy={busy === 'approve'} disabled={blocking}>
            APPROVE & CONTINUE
          </Button>
        </div>
        <p className="mt-3 text-center text-[11px] leading-relaxed text-dim">
          Approving opens {p.firstName || 'their'}’s LinkedIn profile, clicks Connect → Add a note, and inserts this message. You’ll confirm the final
          send on LinkedIn.
        </p>
      </div>
    </div>
  );
}
