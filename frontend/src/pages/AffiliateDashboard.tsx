import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AffiliateDashboard as DashboardData,
  AffiliateClick,
  AffiliateConversion,
  AffiliateEvent,
  AffiliateInvite,
  checkConnectStatus,
  getClicks,
  getConnectLoginLink,
  getConversions,
  getDashboard,
  getEvents,
  joinAsAffiliate,
  listAffiliateInvites,
  sendAffiliateInvite,
  startConnectOnboarding,
} from "../api/affiliate";

function pence(amount: number): string {
  return `£${(amount / 100).toFixed(2)}`;
}

export default function AffiliateDashboard() {
  const [searchParams] = useSearchParams();
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [clicks, setClicks] = useState<AffiliateClick[]>([]);
  const [conversions, setConversions] = useState<AffiliateConversion[]>([]);
  const [events, setEvents] = useState<AffiliateEvent[]>([]);
  const [invites, setInvites] = useState<AffiliateInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [notAffiliate, setNotAffiliate] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteSending, setInviteSending] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function load() {
    try {
      const d = await getDashboard();
      setDashboard(d);
      setNotAffiliate(false);
      const [c, cv, ev] = await Promise.all([
        getClicks(),
        getConversions(),
        getEvents(),
      ]);
      setClicks(c);
      setConversions(cv);
      setEvents(ev);
      if (d.can_send_invites) {
        try {
          setInvites(await listAffiliateInvites());
        } catch {
          /* non-fatal */
        }
      }
    } catch (e: unknown) {
      if (e && typeof e === "object" && "status" in e && (e as { status: number }).status === 404) {
        setNotAffiliate(true);
      } else {
        setError(String(e));
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (searchParams.get("connect") === "complete") {
      checkConnectStatus().then(() => load());
    }
  }, [searchParams]);

  async function handleJoin() {
    setJoining(true);
    try {
      await joinAsAffiliate();
      await load();
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setJoining(false);
    }
  }

  async function handleOnboard() {
    try {
      const { url } = await startConnectOnboarding();
      window.location.href = url;
    } catch (e: unknown) {
      setError(String(e));
    }
  }

  async function handleStripeLogin() {
    try {
      const { url } = await getConnectLoginLink();
      window.open(url, "_blank");
    } catch (e: unknown) {
      setError(String(e));
    }
  }

  async function handleSendInvite(e: React.FormEvent) {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email) return;
    setInviteSending(true);
    setInviteMsg(null);
    try {
      const res = await sendAffiliateInvite(email);
      setInviteEmail("");
      setInvites(await listAffiliateInvites());
      setInviteMsg(
        res.sent
          ? { kind: "ok", text: `30-day trial invite sent to ${email}.` }
          : {
              kind: "err",
              text: `Invite saved but email failed: ${res.send_error || "unknown error"}`,
            }
      );
    } catch (err: unknown) {
      const detail =
        err && typeof err === "object" && "detail" in err
          ? String((err as { detail: unknown }).detail)
          : String(err);
      setInviteMsg({ kind: "err", text: detail });
    } finally {
      setInviteSending(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />
      </div>
    );
  }

  if (notAffiliate) {
    return (
      <div className="max-w-lg mx-auto text-center py-16 space-y-6">
        <h1 className="text-2xl font-bold text-white">Affiliate Programme</h1>
        <p className="text-gray-400">
          Earn 20% commission on every customer you refer to PrintLay.
          Share your unique link and start earning.
        </p>
        <button
          onClick={handleJoin}
          disabled={joining}
          className="rounded-lg bg-violet-600 px-6 py-3 font-semibold text-white hover:bg-violet-500 disabled:opacity-50 transition-colors"
        >
          {joining ? "Joining..." : "Join the affiliate programme"}
        </button>
      </div>
    );
  }

  if (!dashboard) {
    return <p className="text-rose-400 text-center py-8">{error || "Failed to load"}</p>;
  }

  const shareLink = dashboard.share_link;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Affiliate Dashboard</h1>
        <span className={`text-xs px-2 py-0.5 rounded-full border ${
          dashboard.status === "active"
            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
            : "border-gray-600 bg-gray-800 text-gray-400"
        }`}>
          {dashboard.status}
        </span>
      </div>

      {error && <p className="text-rose-400 text-sm">{error}</p>}

      {/* Share link */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 space-y-2">
        <label className="text-xs text-gray-500 uppercase tracking-wider font-medium">
          Your share link
        </label>
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={shareLink}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 select-all"
          />
          <button
            onClick={() => navigator.clipboard.writeText(shareLink)}
            className="shrink-0 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
          >
            Copy
          </button>
        </div>
        {dashboard.vanity_slug && (
          <p className="text-[11px] text-gray-600">
            Your personal vanity link — every click, trial and sale tracks back to you.
          </p>
        )}
      </div>

      {/* Send a 30-day trial invite */}
      {dashboard.can_send_invites && (
        <div className="rounded-xl border border-violet-500/20 bg-violet-500/[0.04] p-4 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Invite a customer</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Send a contact a <strong className="text-gray-300">30-day free trial</strong>.
              The trial — and any sale — is automatically credited to you.
            </p>
          </div>
          <form onSubmit={handleSendInvite} className="flex items-center gap-2">
            <input
              type="email"
              required
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="customer@email.com"
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600"
            />
            <button
              type="submit"
              disabled={inviteSending}
              className="shrink-0 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50 transition-colors"
            >
              {inviteSending ? "Sending…" : "Send invite"}
            </button>
          </form>
          {inviteMsg && (
            <p className={`text-xs ${inviteMsg.kind === "ok" ? "text-emerald-400" : "text-rose-400"}`}>
              {inviteMsg.text}
            </p>
          )}
          {invites.length > 0 && (
            <div className="divide-y divide-gray-800 max-h-56 overflow-y-auto border-t border-gray-800 pt-1">
              {invites.map((inv, i) => (
                <div key={i} className="flex items-center justify-between py-2 text-sm gap-3">
                  <span className="text-gray-300 truncate flex-1">{inv.email}</span>
                  <span className="text-gray-600 text-xs shrink-0">
                    {new Date(inv.created_at).toLocaleDateString()}
                  </span>
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
                      inv.status === "accepted"
                        ? "bg-emerald-500/10 text-emerald-400"
                        : inv.status === "pending"
                        ? "bg-sky-500/10 text-sky-400"
                        : "bg-gray-700/40 text-gray-400"
                    }`}
                  >
                    {inv.status === "accepted" ? "signed up" : inv.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Funnel: clicks → trials → leads → sales */}
      <div>
        <h2 className="text-xs uppercase tracking-wider text-gray-500 font-medium mb-2">
          Your funnel
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Total Clicks" value={dashboard.total_clicks.toLocaleString()} />
          <StatCard
            label="Trials Generated"
            value={dashboard.total_signups.toLocaleString()}
            sub={`${dashboard.signups_30d} in last 30d`}
          />
          <StatCard
            label="Enquiries (chat/ticket)"
            value={dashboard.total_leads.toLocaleString()}
          />
          <StatCard label="Sales" value={dashboard.total_conversions.toLocaleString()} />
        </div>
      </div>

      {/* Rates + earnings */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Click → Sale" value={`${dashboard.conversion_rate}%`} />
        <StatCard label="Trial → Sale" value={`${dashboard.signup_to_sale_rate}%`} />
        <StatCard label="Commission" value={`${(dashboard.commission_rate * 100).toFixed(0)}%`} />
        <StatCard label="Last 30 Days" value={`${dashboard.recent_clicks_30d} clicks`} />
        <StatCard label="Pending Balance" value={pence(dashboard.pending_balance_pence)} highlight />
        <StatCard label="Total Earned" value={pence(dashboard.total_earned_pence)} />
        <StatCard label="Total Paid" value={pence(dashboard.total_paid_pence)} />
        <StatCard
          label="Payout At"
          value={pence(dashboard.min_payout_threshold_pence)}
        />
      </div>

      {/* Stripe Connect */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-white">Payout Setup</h2>
        {dashboard.stripe_connect_onboarding_complete ? (
          <div className="flex items-center justify-between">
            <p className="text-sm text-emerald-400">
              Stripe Connect active — payouts enabled
            </p>
            <button
              onClick={handleStripeLogin}
              className="text-xs text-violet-400 hover:text-violet-300 underline"
            >
              View Stripe dashboard
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-gray-400">
              Complete Stripe onboarding to receive payouts when your balance
              reaches {pence(dashboard.min_payout_threshold_pence)}.
            </p>
            <button
              onClick={handleOnboard}
              className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 transition-colors"
            >
              Set up payouts
            </button>
          </div>
        )}
      </div>

      {/* Recent activity — trials & enquiries (even without a sale) */}
      {events.length > 0 && (
        <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-white">Recent Activity</h2>
          <p className="text-xs text-gray-500">
            Trials and enquiries generated by your link — these don&apos;t earn
            commission on their own, but show your link is working.
          </p>
          <div className="divide-y divide-gray-800 max-h-64 overflow-y-auto">
            {events.slice(0, 30).map((e, i) => (
              <div key={i} className="flex items-center justify-between py-2 text-sm gap-3">
                <span className="text-gray-400 shrink-0">
                  {new Date(e.created_at).toLocaleDateString()}{" "}
                  {new Date(e.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className="text-gray-500 text-xs truncate flex-1 text-right">
                  {e.detail || ""}
                </span>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
                    e.event_type === "signup"
                      ? "bg-sky-500/10 text-sky-400"
                      : e.event_type === "invite"
                      ? "bg-violet-500/10 text-violet-300"
                      : "bg-amber-500/10 text-amber-400"
                  }`}
                >
                  {e.event_type === "signup"
                    ? "trial"
                    : e.event_type === "invite"
                    ? "invite sent"
                    : "enquiry"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent conversions */}
      {conversions.length > 0 && (
        <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-white">Recent Conversions</h2>
          <div className="divide-y divide-gray-800">
            {conversions.slice(0, 10).map((c, i) => (
              <div key={i} className="flex items-center justify-between py-2 text-sm">
                <span className="text-gray-400">
                  {new Date(c.converted_at).toLocaleDateString()}
                </span>
                <span className="text-gray-300">{pence(c.stripe_charge_amount_pence)} sale</span>
                <span className="text-emerald-400 font-medium">{pence(c.commission_pence)}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded ${
                  c.status === "approved" || c.status === "paid"
                    ? "bg-emerald-500/10 text-emerald-400"
                    : c.status === "reversed"
                    ? "bg-rose-500/10 text-rose-400"
                    : "bg-amber-500/10 text-amber-400"
                }`}>
                  {c.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent clicks */}
      {clicks.length > 0 && (
        <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-white">Recent Clicks</h2>
          <div className="divide-y divide-gray-800 max-h-64 overflow-y-auto">
            {clicks.slice(0, 20).map((c, i) => (
              <div key={i} className="flex items-center justify-between py-2 text-sm">
                <span className="text-gray-400">
                  {new Date(c.clicked_at).toLocaleDateString()}{" "}
                  {new Date(c.clicked_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className="text-gray-500 text-xs truncate max-w-[200px]">
                  {c.landing_path || "/"}
                </span>
                {c.converted && (
                  <span className="text-xs bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded">
                    converted
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, highlight, sub }: { label: string; value: string; highlight?: boolean; sub?: string }) {
  return (
    <div className={`rounded-xl border p-3 ${
      highlight
        ? "border-violet-500/30 bg-violet-500/5"
        : "border-gray-800 bg-gray-900/50"
    }`}>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-lg font-semibold ${highlight ? "text-violet-300" : "text-white"}`}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-gray-600 mt-0.5">{sub}</div>}
    </div>
  );
}
