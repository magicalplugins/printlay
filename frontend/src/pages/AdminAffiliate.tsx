import { useEffect, useState } from "react";
import {
  AdminOverview,
  AffiliateListItem,
  PayoutItem,
  getAdminAffiliateList,
  getAdminOverview,
  getPayouts,
  runPayouts,
  updateAffiliate,
} from "../api/affiliate";

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

  useEffect(() => {
    load();
  }, []);

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
        <button
          onClick={handleRunPayouts}
          disabled={payoutRunning}
          className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50 transition-colors"
        >
          {payoutRunning ? "Running..." : "Run Payouts"}
        </button>
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
                <th className="px-3 py-2 text-left">Ref Code</th>
                <th className="px-3 py-2 text-right">Clicks</th>
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
                  <td className="px-3 py-2 text-gray-200">{a.email}</td>
                  <td className="px-3 py-2 text-gray-400 font-mono text-xs">{a.ref_code}</td>
                  <td className="px-3 py-2 text-right text-gray-300">{a.total_clicks}</td>
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
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => handleToggleStatus(a.id, a.status)}
                      className="text-xs text-gray-400 hover:text-white transition-colors"
                    >
                      {a.status === "active" ? "Pause" : "Activate"}
                    </button>
                  </td>
                </tr>
              ))}
              {affiliates.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center py-8 text-gray-500">
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
