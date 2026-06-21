import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import WidgetShell, { btnSecondary, emptyCls } from "./WidgetShell";
import { deleteOrder, listOrders, PrintOrder, sendProof, updateOrderStatus } from "../../api/widget";
import { apiErrMessage } from "../../api/client";

const STATUSES: { key: string; label: string }[] = [
  { key: "", label: "All" },
  { key: "draft", label: "Drafts" },
  { key: "ready_to_print", label: "Ready to print" },
  { key: "printed", label: "Printed" },
  { key: "paid", label: "Paid" },
  { key: "awaiting_proof", label: "Awaiting proof" },
];

type LineItem = {
  asset_id?: string;
  qty?: number;
  test?: boolean;
  options?: { width_mm?: number; height_mm?: number; cut_style?: string; bleed_mm?: number };
};

function isTestOrder(o: PrintOrder): boolean {
  if (o.external_order_id.startsWith("TEST-")) return true;
  return (o.line_items as LineItem[]).some((it) => it.test === true);
}

function sheetLink(o: PrintOrder, item: LineItem): string {
  const params = new URLSearchParams();
  if (item.asset_id) params.set("asset", String(item.asset_id));
  if (item.qty) params.set("qty", String(item.qty));
  // The saved asset includes the bleed margin, so place it at the full
  // (trim + bleed) size — that lands the cut line exactly on the trim.
  const bleed = item.options?.bleed_mm ?? 0;
  if (item.options?.width_mm) params.set("w", String(item.options.width_mm + 2 * bleed));
  if (item.options?.height_mm) params.set("h", String(item.options.height_mm + 2 * bleed));
  // Name the sheet after the order so it's recognisable in the Sheet Builder
  // ("Test order 3", or the customer / store order ref for a real order).
  params.set("name", o.customer_ref || `Order ${o.external_order_id}`);
  return `/app/sheets?${params.toString()}`;
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function itemLabel(item: LineItem): string {
  const w = item.options?.width_mm;
  const h = item.options?.height_mm;
  const size = w && h ? (w === h ? `${w}mm` : `${w}×${h}mm`) : "sticker";
  return `${item.qty ?? 1}× ${size}`;
}

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-neutral-500/15 text-neutral-300 border-neutral-500/30",
  paid: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  ready_to_print: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  printed: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
};

const PROOF_BADGE: Record<string, string> = {
  awaiting_proof: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  proof_sent: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  proof_approved: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  proof_rejected: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

export default function WidgetOrders() {
  const [searchParams] = useSearchParams();
  const [orders, setOrders] = useState<PrintOrder[] | null>(null);
  const [filter, setFilter] = useState(searchParams.get("status") || "");
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();

  const load = (f: string) =>
    listOrders(f || undefined)
      .then(setOrders)
      .catch((e) => setErr(apiErrMessage(e)));

  useEffect(() => {
    load(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const mark = async (o: PrintOrder, status: PrintOrder["status"]) => {
    try {
      await updateOrderStatus(o.id, status);
      load(filter);
    } catch (e) {
      setErr(apiErrMessage(e));
    }
  };

  const remove = async (o: PrintOrder) => {
    if (!confirm(`Delete order #${o.external_order_id}? This can't be undone.`)) return;
    try {
      await deleteOrder(o.id);
      load(filter);
    } catch (e) {
      setErr(apiErrMessage(e));
    }
  };

  const handleSendProof = async (o: PrintOrder) => {
    try {
      await sendProof(o.id);
      load(filter);
    } catch (e) {
      setErr(apiErrMessage(e));
    }
  };

  return (
    <WidgetShell
      title="Orders"
      subtitle="Designs land here when customers add to cart — open one straight onto a sheet to gang and print."
      actions={
        <div className="flex items-center gap-1">
          {STATUSES.map((s) => (
            <button
              key={s.key}
              onClick={() => setFilter(s.key)}
              className={`px-3 py-1.5 text-sm rounded-lg ${
                filter === s.key
                  ? "bg-neutral-800 text-white"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      }
    >
      {err && <div className="text-rose-400 text-sm mb-4">{err}</div>}

      {orders === null ? (
        <div className="text-neutral-500 text-sm">Loading…</div>
      ) : orders.length === 0 ? (
        <div className={emptyCls}>
          No orders yet. They'll appear here once customers design through the widget.
        </div>
      ) : (
        <div className="rounded-2xl border border-neutral-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-neutral-950/80 text-neutral-500 text-xs uppercase tracking-widest">
              <tr>
                <th className="text-left font-normal px-4 py-2">Order</th>
                <th className="text-left font-normal px-4 py-2">Customer</th>
                <th className="text-left font-normal px-4 py-2">Items</th>
                <th className="text-right font-normal px-4 py-2">Total</th>
                <th className="text-left font-normal px-4 py-2">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-900">
              {orders.map((o) => (
                <tr key={o.id} className="hover:bg-neutral-900/40">
                  <td className="px-4 py-2.5">
                    <div className="font-medium flex items-center gap-2">
                      #{o.external_order_id}
                      {isTestOrder(o) && (
                        <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] uppercase tracking-widest rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-300">
                          Test
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-neutral-500 capitalize">{o.platform}</div>
                    <div className="text-xs text-neutral-600 mt-0.5">{fmtDate(o.created_at)}</div>
                  </td>
                  <td className="px-4 py-2.5 text-neutral-300">{o.customer_ref || "—"}</td>
                  <td className="px-4 py-2.5 text-neutral-400">
                    {o.line_items.length === 0 ? (
                      "—"
                    ) : (
                      <div className="space-y-1">
                        {(o.line_items as LineItem[]).map((it, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <span>{itemLabel(it)}</span>
                            {it.asset_id && (
                              <button
                                onClick={() => nav(sheetLink(o, it))}
                                className="text-violet-300 hover:text-violet-200 text-xs whitespace-nowrap"
                              >
                                Open on sheet →
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {o.currency} {o.amount_total.toFixed(2)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 text-[10px] uppercase tracking-widest rounded-full border ${STATUS_BADGE[o.status] || "bg-neutral-500/15 text-neutral-300 border-neutral-500/30"}`}
                    >
                      {o.status.replace(/_/g, " ")}
                    </span>
                    {o.proof_status && (
                      <span
                        className={`ml-1.5 inline-flex items-center px-2 py-0.5 text-[10px] uppercase tracking-widest rounded-full border ${PROOF_BADGE[o.proof_status] || ""}`}
                      >
                        {o.proof_status.replace(/_/g, " ")}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap space-x-2">
                    {o.proof_status === "awaiting_proof" && (
                      <button className={btnSecondary} onClick={() => handleSendProof(o)}>
                        Send proof
                      </button>
                    )}
                    {o.proof_status === "proof_rejected" && (
                      <button className={btnSecondary} onClick={() => handleSendProof(o)}>
                        Re-send proof
                      </button>
                    )}
                    {!o.proof_status && o.status === "draft" && (
                      <button className={btnSecondary} onClick={() => mark(o, "ready_to_print")}>
                        Send to print queue
                      </button>
                    )}
                    {o.status === "ready_to_print" && (
                      <button className={btnSecondary} onClick={() => mark(o, "printed")}>
                        Mark printed
                      </button>
                    )}
                    {o.status === "printed" && (
                      <button
                        className="text-xs text-neutral-500 hover:text-neutral-300"
                        onClick={() => mark(o, "ready_to_print")}
                      >
                        Reopen
                      </button>
                    )}
                    <button
                      className="text-xs text-neutral-600 hover:text-rose-300"
                      onClick={() => remove(o)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </WidgetShell>
  );
}
