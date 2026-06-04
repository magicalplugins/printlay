import { useEffect, useState } from "react";
import {
  AdminOverview,
  AffiliateDetail,
  AffiliateListItem,
  PayoutItem,
  createGhostAffiliate,
  deleteAffiliate,
  getAdminAffiliateList,
  getAdminOverview,
  getAffiliateReferrals,
  getPayouts,
  resendAffiliateWelcome,
  runPayouts,
  updateAffiliate,
} from "../api/affiliate";
import { apiErrMessage } from "../api/client";

function pence(amount: number): string {
  return `£${(amount / 100).toFixed(2)}`;
}

export default function AdminAffiliate() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [affiliates, setAffiliates] = useState<AffiliateListItem[]>([]);
  const [payouts, setPayouts] = useState<PayoutItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [payoutRunning, setPayoutRunning] = useState(false);
  const [payoutResult, setPayoutResult] = useState<string | null>(null);
  const [tab, setTab] = useState<"affiliates" | "payouts">("affiliates");
  const [showGhostForm, setShowGhostForm] = useState(false);
  const [detail, setDetail] = useState<AffiliateDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function openDetail(id: string) {
    setDetailLoading(true);
    setDetail(null);
    try {
      setDetail(await getAffiliateReferrals(id));
    } catch (e: unknown) {
      setPayoutResult(`Error loading referrals: ${e}`);
    } finally {
      setDetailLoading(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* noop */
    }
  }

  async function load() {
    setLoading(true);
    try {
      const [o, a, p] = await Promise.all([
        getAdminOverview(),
        getAdminAffiliateList(),
        getPayouts(),
      ]);
      setOverview(o);
      setAffiliates(a);
      setPayouts(p);
    } catch {
      // fallback
    } finally {
      setLoading(false);
    }
  }

  async function handleRunPayouts() {
    setPayoutRunning(true);
    setPayoutResult(null);
    try {
      const res = await runPayouts();
      setPayoutResult(
        `Approved ${res.conversions_approved} conversions. ${res.results.length} payouts processed.`
      );
      await load();
    } catch (e: unknown) {
      setPayoutResult(`Error: ${e}`);
    } finally {
      setPayoutRunning(false);
    }
  }

  async function handleToggleStatus(id: string, current: string) {
    const next = current === "active" ? "paused" : "active";
    await updateAffiliate(id, { status: next });
    await load();
  }

  async function handleDeleteAffiliate(a: AffiliateListItem) {
    const warning = a.has_account
      ? `Delete affiliate "${a.email}"?\n\nThey have a Printlay account. If it is NOT a paying customer, the entire account and ALL its data will be permanently deleted (templates, jobs, artwork, outputs) along with their Supabase login. Paying customers and admins are protected — only the affiliate records are removed.\n\nThis cannot be undone.`
      : `Delete affiliate "${a.email}"?\n\nThis removes their affiliate records (clicks, conversions, payouts, events). This cannot be undone.`;
    if (!window.confirm(warning)) return;
    try {
      const res = await deleteAffiliate(a.id);
      setPayoutResult(res.message);
      await load();
    } catch (e: unknown) {
      setPayoutResult(`Delete failed: ${apiErrMessage(e)}`);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Affiliate Admin</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowGhostForm(true)}
            className="rounded-lg border border-violet-500/40 bg-violet-500/10 px-4 py-2 text-sm font-semibold text-violet-300 hover:bg-violet-500/20 transition-colors"
          >
            + Add ghost affiliate
          </button>
          <button
            onClick={handleRunPayouts}
            disabled={payoutRunning}
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50 transition-colors"
          >
            {payoutRunning ? "Running..." : "Run Payouts"}
          </button>
        </div>
      </div>

      {payoutResult && (
        <div className="text-sm text-emerald-400 bg-emerald-500/5 border border-emerald-500/30 rounded-lg px-3 py-2">
          {payoutResult}
        </div>
      )}

      {/* Overview stats */}
      {overview && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <OvCard label="Total Affiliates" value={overview.total_affiliates} />
          <OvCard label="Active" value={overview.active_affiliates} />
          <OvCard label="Total Clicks" value={overview.total_clicks} />
          <OvCard label="Trials Generated" value={overview.total_signups} />
          <OvCard label="Enquiries" value={overview.total_leads} />
          <OvCard label="Conversions" value={overview.total_conversions} />
          <OvCard label="Commission Earned" value={pence(overview.total_commission_pence)} />
          <OvCard label="Total Paid" value={pence(overview.total_paid_pence)} />
          <OvCard label="Pending Balance" value={pence(overview.pending_balance_pence)} />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-800">
        <TabBtn active={tab === "affiliates"} onClick={() => setTab("affiliates")}>
          Affiliates ({affiliates.length})
        </TabBtn>
        <TabBtn active={tab === "payouts"} onClick={() => setTab("payouts")}>
          Payouts ({payouts.length})
        </TabBtn>
      </div>

      {tab === "affiliates" && (
        <div className="rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-900/80 text-gray-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="px-3 py-2 text-left">Email</th>
                <th className="px-3 py-2 text-left">Link</th>
                <th className="px-3 py-2 text-right">Clicks</th>
                <th className="px-3 py-2 text-right">Trials</th>
                <th className="px-3 py-2 text-right">Enq.</th>
                <th className="px-3 py-2 text-right">Conv.</th>
                <th className="px-3 py-2 text-right">Earned</th>
                <th className="px-3 py-2 text-right">Paid</th>
                <th className="px-3 py-2 text-right">Pending</th>
                <th className="px-3 py-2 text-center">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {affiliates.map((a) => (
                <tr key={a.id} className="hover:bg-gray-900/40">
                  <td className="px-3 py-2 text-gray-200">
                    <div className="flex items-center gap-1.5">
                      {a.is_ghost && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-violet-500/15 text-violet-300 shrink-0">
                          ghost
                        </span>
                      )}
                      <span className="truncate max-w-[180px]">{a.email}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => copy(a.share_link)}
                      title={`${a.share_link} — click to copy`}
                      className="text-gray-400 hover:text-violet-300 font-mono text-xs transition-colors"
                    >
                      {a.share_link.replace(/^https?:\/\//, "")}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-right text-gray-300">{a.total_clicks}</td>
                  <td className="px-3 py-2 text-right text-gray-300">{a.total_signups}</td>
                  <td className="px-3 py-2 text-right text-gray-300">{a.total_leads}</td>
                  <td className="px-3 py-2 text-right text-gray-300">{a.total_conversions}</td>
                  <td className="px-3 py-2 text-right text-gray-300">{pence(a.total_earned_pence)}</td>
                  <td className="px-3 py-2 text-right text-gray-300">{pence(a.total_paid_pence)}</td>
                  <td className="px-3 py-2 text-right text-violet-300 font-medium">{pence(a.pending_balance_pence)}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      a.status === "active"
                        ? "bg-emerald-500/10 text-emerald-400"
                        : "bg-gray-700 text-gray-400"
                    }`}>
                      {a.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button
                      onClick={() => openDetail(a.id)}
                      className="text-xs text-violet-400 hover:text-violet-300 transition-colors mr-3"
                    >
                      View
                    </button>
                    {a.is_ghost && (
                      <button
                        onClick={async () => {
                          const r = await resendAffiliateWelcome(a.id);
                          setPayoutResult(
                            r.ok ? "Welcome email re-sent." : `Email failed: ${r.error}`
                          );
                        }}
                        className="text-xs text-gray-400 hover:text-white transition-colors mr-3"
                      >
                        Re-email
                      </button>
                    )}
                    <button
                      onClick={() => handleToggleStatus(a.id, a.status)}
                      className="text-xs text-gray-400 hover:text-white transition-colors mr-3"
                    >
                      {a.status === "active" ? "Pause" : "Activate"}
                    </button>
                    <button
                      onClick={() => handleDeleteAffiliate(a)}
                      className="text-xs text-rose-400 hover:text-rose-300 transition-colors"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {affiliates.length === 0 && (
                <tr>
                  <td colSpan={11} className="text-center py-8 text-gray-500">
                    No affiliates yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === "payouts" && (
        <div className="rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-900/80 text-gray-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Affiliate</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-center">Status</th>
                <th className="px-3 py-2 text-left">Transfer ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {payouts.map((p) => (
                <tr key={p.id} className="hover:bg-gray-900/40">
                  <td className="px-3 py-2 text-gray-300">
                    {p.paid_at ? new Date(p.paid_at).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-3 py-2 text-gray-400 font-mono text-xs">
                    {p.affiliate_id.slice(0, 8)}…
                  </td>
                  <td className="px-3 py-2 text-right text-white font-medium">{pence(p.amount_pence)}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      p.status === "paid"
                        ? "bg-emerald-500/10 text-emerald-400"
                        : "bg-amber-500/10 text-amber-400"
                    }`}>
                      {p.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-500 text-xs font-mono">
                    {p.stripe_transfer_id || "—"}
                  </td>
                </tr>
              ))}
              {payouts.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center py-8 text-gray-500">
                    No payouts yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {showGhostForm && (
        <GhostForm
          onClose={() => setShowGhostForm(false)}
          onCreated={() => {
            setShowGhostForm(false);
            load();
          }}
        />
      )}

      {(detail || detailLoading) && (
        <ReferralsModal
          detail={detail}
          loading={detailLoading}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

function GhostForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [commission, setCommission] = useState(20);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ link: string; sent: boolean; error: string | null } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await createGhostAffiliate({
        email: email.trim(),
        name: name.trim() || undefined,
        vanity_slug: slug.trim(),
        commission_rate: commission / 100,
      });
      setDone({ link: res.share_link, sent: res.welcome_email_sent, error: res.welcome_email_error });
    } catch (e: unknown) {
      setErr(apiErrMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-950 p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        {done ? (
          <div className="space-y-4">
            <h2 className="text-lg font-bold text-white">Ghost affiliate created</h2>
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3">
              <div className="text-xs text-gray-500 mb-1">Vanity link</div>
              <div className="text-sm text-violet-300 font-mono break-all">{done.link}</div>
            </div>
            <p className={`text-sm ${done.sent ? "text-emerald-400" : "text-amber-400"}`}>
              {done.sent
                ? "Welcome email sent."
                : `Welcome email not sent: ${done.error || "email not configured"}`}
            </p>
            <button
              onClick={onCreated}
              className="w-full rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <h2 className="text-lg font-bold text-white">Add ghost affiliate</h2>
            <p className="text-xs text-gray-500">
              Creates a hand-picked partner with a vanity link and auto-sends their welcome email.
              The account stays locked (no product access) until they sign up and you grant a trial.
            </p>
            {err && <p className="text-sm text-rose-400">{err}</p>}
            <div className="space-y-1">
              <label className="text-xs text-gray-500">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-gray-500">Name (optional)</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-gray-500">Vanity handle</label>
              <div className="flex items-center gap-1">
                <span className="text-sm text-gray-500">printlay.co.uk/</span>
                <input
                  required
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase())}
                  placeholder="morgane"
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200"
                />
              </div>
              <p className="text-[11px] text-gray-600">3–40 lowercase letters, numbers or hyphens.</p>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-gray-500">Commission %</label>
              <input
                type="number"
                min={1}
                max={100}
                value={commission}
                onChange={(e) => setCommission(Number(e.target.value))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200"
              />
            </div>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="flex-1 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50 transition-colors"
              >
                {busy ? "Creating…" : "Create & email"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function ReferralsModal({
  detail,
  loading,
  onClose,
}: {
  detail: AffiliateDetail | null;
  loading: boolean;
  onClose: () => void;
}) {
  const statusStyle: Record<string, string> = {
    customer: "bg-emerald-500/10 text-emerald-400",
    trial: "bg-sky-500/10 text-sky-400",
    invited: "bg-amber-500/10 text-amber-400",
    expired: "bg-gray-700/40 text-gray-400",
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-2xl border border-gray-800 bg-gray-950 p-6 space-y-4 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">
            {detail ? detail.name || detail.email : "Referrals"}
          </h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>
        {loading && (
          <div className="flex items-center justify-center py-10">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />
          </div>
        )}
        {detail && (
          <div className="space-y-6">
            {/* People referred (signups, trials, customers, pending invites) */}
            <div className="space-y-2">
              <h3 className="text-xs uppercase tracking-wider text-gray-500">
                People referred ({detail.referrals.length})
              </h3>
              {detail.referrals.length === 0 ? (
                <p className="text-sm text-gray-500 py-3">No sign-ups or invites yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-gray-500 text-xs uppercase tracking-wider">
                    <tr>
                      <th className="px-2 py-1 text-left">Person</th>
                      <th className="px-2 py-1 text-left">Signed up</th>
                      <th className="px-2 py-1 text-left">Trial ends</th>
                      <th className="px-2 py-1 text-center">Status</th>
                      <th className="px-2 py-1 text-right">Commission</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {detail.referrals.map((r, i) => (
                      <tr key={i}>
                        <td className="px-2 py-2 text-gray-200 truncate max-w-[220px]">{r.email}</td>
                        <td className="px-2 py-2 text-gray-400">
                          {r.signed_up_at ? new Date(r.signed_up_at).toLocaleDateString() : "—"}
                        </td>
                        <td className="px-2 py-2 text-gray-400">
                          {r.trial_ends_at ? new Date(r.trial_ends_at).toLocaleDateString() : "—"}
                        </td>
                        <td className="px-2 py-2 text-center">
                          <span className={`text-xs px-1.5 py-0.5 rounded ${statusStyle[r.status] || "bg-gray-700/40 text-gray-400"}`}>
                            {r.status}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-right text-gray-300">
                          {r.commission_pence ? pence(r.commission_pence) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Enquiries — the actual chat / ticket messages they submitted */}
            <div className="space-y-2">
              <h3 className="text-xs uppercase tracking-wider text-gray-500">
                Enquiries ({detail.enquiries.length})
              </h3>
              {detail.enquiries.length === 0 ? (
                <p className="text-sm text-gray-500 py-3">No enquiries from this link yet.</p>
              ) : (
                <ul className="space-y-2">
                  {detail.enquiries.map((e, i) => (
                    <li
                      key={i}
                      className="rounded-lg border border-gray-800 bg-gray-900/40 p-3 space-y-1"
                    >
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="text-sm text-gray-200 font-medium truncate">
                          {e.name || e.email || "Anonymous enquiry"}
                          {e.email && e.name && (
                            <span className="text-gray-500 font-normal"> · {e.email}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs">
                          {e.category && (
                            <span className="px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-300">
                              {e.category}
                            </span>
                          )}
                          {e.status && (
                            <span className="px-1.5 py-0.5 rounded bg-gray-700/40 text-gray-300">
                              {e.status}
                            </span>
                          )}
                          <span className="text-gray-500">
                            {e.submitted_at ? new Date(e.submitted_at).toLocaleDateString() : "—"}
                          </span>
                        </div>
                      </div>
                      {e.exists ? (
                        <p className="text-sm text-gray-400 whitespace-pre-wrap break-words">
                          {e.message}
                        </p>
                      ) : (
                        <p className="text-xs italic text-gray-600">
                          This enquiry was logged but the message has since been deleted.
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function OvCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-3">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-lg font-semibold text-white">{value}</div>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? "text-violet-400 border-b-2 border-violet-400"
          : "text-gray-400 hover:text-gray-200"
      }`}
    >
      {children}
    </button>
  );
}
