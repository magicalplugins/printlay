import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AdminInvite,
  InviteStatus,
  createAdminInvite,
  getAdminInvites,
  resendAdminInvite,
  revokeAdminInvite,
} from "../api/admin";

/* ─────────────────────────────────────────────────────────────────────
   Admin Invites — issue extended-trial invites to hand-picked prospects.

   Two-pane layout mirroring AdminLeads: composer on the left, recent
   invites on the right. Status pill colours follow the Printlay
   palette (violet for the "in-flight" feel).
   ───────────────────────────────────────────────────────────────────── */

const PRESET_DAYS = [14, 30, 60, 90];

const STATUS_TABS: { id: InviteStatus | "all"; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "accepted", label: "Accepted" },
  { id: "revoked", label: "Revoked" },
  { id: "expired", label: "Expired" },
  { id: "all", label: "All" },
];

function statusPill(status: InviteStatus) {
  const map: Record<InviteStatus, string> = {
    pending: "bg-violet-500/15 text-violet-300 border-violet-500/30",
    accepted: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    revoked: "bg-rose-500/15 text-rose-300 border-rose-500/30",
    expired: "bg-neutral-500/15 text-neutral-400 border-neutral-500/30",
  };
  const labels: Record<InviteStatus, string> = {
    pending: "Pending",
    accepted: "Accepted",
    revoked: "Revoked",
    expired: "Expired",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-[10px] uppercase tracking-widest rounded-full border ${map[status]}`}
    >
      {labels[status]}
    </span>
  );
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function AdminInvites() {
  const [filter, setFilter] = useState<InviteStatus | "all">("pending");
  const [invites, setInvites] = useState<AdminInvite[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [listErr, setListErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Composer state
  const [email, setEmail] = useState("");
  const [days, setDays] = useState(30);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [composerErr, setComposerErr] = useState<string | null>(null);
  const [justSent, setJustSent] = useState<AdminInvite | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setListErr(null);
    try {
      const page = await getAdminInvites(
        filter === "all" ? undefined : filter
      );
      setInvites(page.items);
    } catch (e) {
      setListErr(String(e));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const by: Record<string, number> = { pending: 0, accepted: 0, revoked: 0, expired: 0 };
    (invites ?? []).forEach((i) => {
      by[i.status] = (by[i.status] ?? 0) + 1;
    });
    return by;
  }, [invites]);

  const selected = useMemo(
    () => (invites ?? []).find((i) => i.id === selectedId) ?? null,
    [invites, selectedId]
  );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setComposerErr(null);
    setJustSent(null);
    setBusy(true);
    try {
      const result = await createAdminInvite({
        email: email.trim().toLowerCase(),
        trial_days: days,
        note: note.trim() || null,
      });
      setJustSent(result.invite);
      if (!result.sent) {
        setComposerErr(
          `Invite saved but email send failed: ${result.send_error ?? "unknown"}. Copy the link below and share it manually.`
        );
      }
      setEmail("");
      setNote("");
      await load();
    } catch (err) {
      setComposerErr(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyToClipboard(url: string, id: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(id);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      window.prompt("Copy this URL:", url);
    }
  }

  async function onResend(invite: AdminInvite) {
    if (!window.confirm(`Resend the invite email to ${invite.email}?`)) return;
    try {
      await resendAdminInvite(invite.id);
      await load();
    } catch (e) {
      alert(`Resend failed: ${e}`);
    }
  }

  async function onRevoke(invite: AdminInvite, revoke: boolean) {
    const verb = revoke ? "revoke" : "restore";
    if (!window.confirm(`${revoke ? "Revoke" : "Restore"} the invite for ${invite.email}?`))
      return;
    try {
      await revokeAdminInvite(invite.id, revoke);
      await load();
    } catch (e) {
      alert(`${verb} failed: ${e}`);
    }
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="text-xs uppercase tracking-widest text-neutral-500 mb-1">
            <Link to="/app/admin" className="hover:text-neutral-300">
              ← Admin
            </Link>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">
            Trial invites
          </h1>
          <p className="text-neutral-500 text-sm mt-1 max-w-xl">
            Personally invite a prospect with a longer, full-Pro trial.
            Each invite is single-use and tied to one email address.
          </p>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[420px_1fr] gap-6">
        {/* ── Composer ────────────────────────────────────────────── */}
        <section className="rounded-2xl border border-neutral-800 bg-gradient-to-br from-violet-500/[0.04] to-fuchsia-500/[0.02] p-5 space-y-4 self-start">
          <div>
            <h2 className="text-sm font-semibold">Send a new invite</h2>
            <p className="text-xs text-neutral-500 mt-1">
              The recipient gets a branded "you've been invited" email
              with their unique signup link.
            </p>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="block text-[11px] uppercase tracking-widest text-neutral-500 mb-1.5">
                Email
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="founder@studio.com"
                className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 h-10 text-sm outline-none focus:border-violet-500/60"
                autoComplete="off"
              />
            </div>

            <div>
              <div className="flex items-baseline justify-between mb-1.5">
                <label className="block text-[11px] uppercase tracking-widest text-neutral-500">
                  Trial length
                </label>
                <span className="text-xs text-neutral-400">
                  <span className="font-semibold text-neutral-100 tabular-nums">
                    {days}
                  </span>{" "}
                  days
                </span>
              </div>
              <div className="flex items-center gap-2 mb-2">
                {PRESET_DAYS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDays(d)}
                    className={`flex-1 h-8 rounded-lg text-xs font-medium border transition ${
                      days === d
                        ? "bg-violet-500/15 border-violet-500/40 text-violet-200"
                        : "border-neutral-800 text-neutral-400 hover:border-neutral-700"
                    }`}
                  >
                    {d}d
                  </button>
                ))}
              </div>
              <input
                type="range"
                min={1}
                max={180}
                value={days}
                onChange={(e) => setDays(parseInt(e.target.value, 10))}
                className="w-full accent-violet-500"
              />
              <div className="flex justify-between text-[10px] text-neutral-600 mt-1">
                <span>1 day</span>
                <span>180 days</span>
              </div>
            </div>

            <div>
              <label className="block text-[11px] uppercase tracking-widest text-neutral-500 mb-1.5">
                Internal note <span className="text-neutral-700">(optional)</span>
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={2000}
                placeholder="Met at Drupa, runs 12-press shop in Manchester"
                className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-violet-500/60 resize-none"
              />
              <p className="text-[10px] text-neutral-600 mt-1">
                Only visible here — not shown to the recipient.
              </p>
            </div>

            {composerErr && (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-200">
                {composerErr}
              </div>
            )}

            <button
              type="submit"
              disabled={busy || !email.trim()}
              className="w-full rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 px-4 h-11 text-sm font-semibold text-white hover:from-violet-400 hover:to-fuchsia-400 disabled:opacity-40"
            >
              {busy ? "Sending…" : `Send invite · ${days}-day trial →`}
            </button>
          </form>

          {justSent && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2">
              <div className="text-xs font-semibold text-emerald-200">
                Invite sent to {justSent.email}
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-[10px] text-neutral-400 font-mono bg-neutral-950/60 rounded px-2 py-1.5 truncate">
                  {justSent.invite_url}
                </code>
                <button
                  type="button"
                  onClick={() => copyToClipboard(justSent.invite_url, justSent.id)}
                  className="text-[11px] font-semibold text-violet-300 hover:text-violet-200 shrink-0"
                >
                  {copied === justSent.id ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>
          )}
        </section>

        {/* ── List ────────────────────────────────────────────────── */}
        <section className="space-y-3 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            {STATUS_TABS.map((t) => {
              const count = t.id === "all" ? null : counts[t.id] ?? 0;
              const active = filter === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => {
                    setFilter(t.id);
                    setSelectedId(null);
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 h-8 text-xs font-medium border transition ${
                    active
                      ? "bg-neutral-100 text-neutral-950 border-neutral-100"
                      : "border-neutral-800 text-neutral-400 hover:border-neutral-700"
                  }`}
                >
                  {t.label}
                  {count !== null && count > 0 && (
                    <span
                      className={`tabular-nums text-[10px] ${
                        active ? "text-neutral-600" : "text-neutral-500"
                      }`}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="rounded-xl border border-neutral-800 overflow-hidden">
            {loading ? (
              <div className="p-8 text-center text-sm text-neutral-500">
                Loading…
              </div>
            ) : listErr ? (
              <div className="p-8 text-center text-sm text-rose-300">
                {listErr}
              </div>
            ) : (invites ?? []).length === 0 ? (
              <div className="p-8 text-center text-sm text-neutral-500">
                No invites in this view.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-neutral-950/80 text-neutral-500 text-xs uppercase tracking-widest">
                  <tr>
                    <th className="text-left font-normal px-4 py-2">
                      Recipient
                    </th>
                    <th className="text-left font-normal px-4 py-2">Trial</th>
                    <th className="text-left font-normal px-4 py-2">Status</th>
                    <th className="text-left font-normal px-4 py-2">Sent</th>
                    <th className="text-right font-normal px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-900">
                  {invites!.map((inv) => (
                    <tr
                      key={inv.id}
                      onClick={() =>
                        setSelectedId((s) => (s === inv.id ? null : inv.id))
                      }
                      className={`cursor-pointer transition ${
                        selectedId === inv.id
                          ? "bg-violet-500/5"
                          : "hover:bg-neutral-900/40"
                      }`}
                    >
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-neutral-100 truncate max-w-[260px]">
                          {inv.email}
                        </div>
                        {inv.note && (
                          <div className="text-xs text-neutral-500 truncate max-w-[260px]">
                            {inv.note}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-neutral-300 tabular-nums">
                        {inv.trial_days}d
                      </td>
                      <td className="px-4 py-2.5">{statusPill(inv.status)}</td>
                      <td className="px-4 py-2.5 text-neutral-400">
                        {formatRelative(inv.sent_at)}
                      </td>
                      <td
                        className="px-4 py-2.5 text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          onClick={() =>
                            copyToClipboard(inv.invite_url, inv.id)
                          }
                          className="text-xs font-medium text-violet-300 hover:text-violet-200"
                          title="Copy invite URL"
                        >
                          {copied === inv.id ? "Copied!" : "Copy link"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Selected invite — detail card */}
          {selected && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs uppercase tracking-widest text-neutral-500">
                    Invite for
                  </div>
                  <div className="font-semibold text-neutral-100 mt-0.5 truncate">
                    {selected.email}
                  </div>
                </div>
                {statusPill(selected.status)}
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <dt className="text-neutral-500">Trial granted</dt>
                <dd className="text-neutral-200 tabular-nums">
                  {selected.trial_days} days
                </dd>

                <dt className="text-neutral-500">Created</dt>
                <dd className="text-neutral-200">
                  {new Date(selected.created_at).toLocaleString()}
                </dd>

                <dt className="text-neutral-500">Link expires</dt>
                <dd className="text-neutral-200">
                  {new Date(selected.expires_at).toLocaleString()}
                </dd>

                <dt className="text-neutral-500">Last sent</dt>
                <dd className="text-neutral-200">
                  {selected.sent_at
                    ? new Date(selected.sent_at).toLocaleString()
                    : "—"}
                </dd>

                {selected.accepted_at && (
                  <>
                    <dt className="text-neutral-500">Accepted</dt>
                    <dd className="text-neutral-200">
                      {new Date(selected.accepted_at).toLocaleString()}
                    </dd>
                  </>
                )}

                {selected.invited_by_email && (
                  <>
                    <dt className="text-neutral-500">Invited by</dt>
                    <dd className="text-neutral-200">
                      {selected.invited_by_email}
                    </dd>
                  </>
                )}
              </dl>

              {selected.note && (
                <div>
                  <div className="text-[11px] uppercase tracking-widest text-neutral-500 mb-1">
                    Note
                  </div>
                  <div className="text-xs text-neutral-300 bg-neutral-900/60 rounded-lg p-3 whitespace-pre-wrap">
                    {selected.note}
                  </div>
                </div>
              )}

              <div>
                <div className="text-[11px] uppercase tracking-widest text-neutral-500 mb-1">
                  Invite URL
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-[10px] text-neutral-400 font-mono bg-neutral-950 border border-neutral-800 rounded px-2 py-1.5 truncate">
                    {selected.invite_url}
                  </code>
                  <button
                    onClick={() =>
                      copyToClipboard(selected.invite_url, selected.id)
                    }
                    className="text-xs font-semibold text-violet-300 hover:text-violet-200 shrink-0"
                  >
                    {copied === selected.id ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1 flex-wrap">
                {selected.status === "pending" && (
                  <>
                    <button
                      onClick={() => onResend(selected)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-700 px-3 h-8 text-xs font-medium text-neutral-200 hover:border-neutral-500"
                    >
                      Resend email
                    </button>
                    <button
                      onClick={() => onRevoke(selected, true)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 px-3 h-8 text-xs font-medium text-rose-300 hover:bg-rose-500/10"
                    >
                      Revoke
                    </button>
                  </>
                )}
                {selected.status === "revoked" && (
                  <button
                    onClick={() => onRevoke(selected, false)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-700 px-3 h-8 text-xs font-medium text-neutral-200 hover:border-neutral-500"
                  >
                    Restore
                  </button>
                )}
                {selected.accepted_user_id && (
                  <Link
                    to={`/app/admin/users`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-700 px-3 h-8 text-xs font-medium text-neutral-200 hover:border-neutral-500"
                  >
                    View user →
                  </Link>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
