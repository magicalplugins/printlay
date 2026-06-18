import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import WidgetShell, { btnPrimary, card, emptyCls, inputCls, labelCls } from "./WidgetShell";
import { Product, createPreviewSession, listProducts } from "../../api/widget";
import { apiErrMessage } from "../../api/client";

interface CartPayload {
  design_ref: string;
  quote_token: string;
  total: number;
  currency: string;
  quantity: number;
  options: Record<string, unknown>;
}

export default function WidgetPreview() {
  const [params, setParams] = useSearchParams();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [productId, setProductId] = useState<string>(params.get("product") || "");
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cart, setCart] = useState<CartPayload | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    listProducts()
      .then((p) => {
        setProducts(p);
        if (!productId && p.length) setProductId(p[0].id);
      })
      .catch((e) => setErr(apiErrMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Capture the simulated add-to-cart message the widget posts to its parent.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data && e.data.type === "printlay:add-to-cart") {
        setCart(e.data as CartPayload);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const launch = async () => {
    if (!productId) return;
    setLoading(true);
    setErr(null);
    setCart(null);
    setToken(null);
    try {
      const r = await createPreviewSession(productId);
      setToken(r.session_token);
      setParams({ product: productId });
    } catch (e) {
      setErr(apiErrMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <WidgetShell
      title="Live preview"
      subtitle="Design a sticker exactly as your customers will. The 'Add to cart' result shown here is what your store plugin receives."
    >
      {err && <div className="text-rose-400 text-sm mb-4">{err}</div>}

      <div className={`${card} mb-6`}>
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[220px]">
            <label className={labelCls}>Product</label>
            <select className={inputCls} value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">— choose a product —</option>
              {(products || []).map((p) => (
                <option key={p.id} value={p.id} disabled={!p.is_active}>
                  {p.name}
                  {!p.is_active ? " (inactive)" : ""}
                </option>
              ))}
            </select>
          </div>
          <button className={btnPrimary} disabled={!productId || loading} onClick={launch}>
            {loading ? "Starting…" : token ? "Restart preview" : "Launch preview"}
          </button>
        </div>
        {products && products.length === 0 && (
          <p className="text-sm text-neutral-500 mt-3">Create a product first to preview it.</p>
        )}
      </div>

      {token ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="rounded-2xl border border-neutral-800 overflow-hidden bg-white">
            <iframe
              ref={iframeRef}
              title="Sticker designer preview"
              src={`/embed/sticker?token=${encodeURIComponent(token)}`}
              className="w-full"
              style={{ height: "720px", border: "0" }}
            />
          </div>
          <div className={card}>
            <h3 className="font-semibold text-sm mb-2">Plugin would receive</h3>
            {cart ? (
              <div className="space-y-2 text-sm">
                <Row label="Total" value={`${cart.currency} ${cart.total.toFixed(2)}`} />
                <Row label="Quantity" value={String(cart.quantity)} />
                <Row label="Design ref" value={cart.design_ref} mono />
                <div>
                  <div className="text-xs text-neutral-500 mt-2 mb-1">Options</div>
                  <pre className="text-[11px] bg-neutral-950/60 rounded-lg p-2 overflow-x-auto text-neutral-300">
                    {JSON.stringify(cart.options, null, 2)}
                  </pre>
                </div>
                <div>
                  <div className="text-xs text-neutral-500 mt-2 mb-1">Signed quote token</div>
                  <code className="block text-[10px] break-all text-neutral-500">{cart.quote_token}</code>
                </div>
                <a
                  href="/app/widget/orders?status=draft"
                  className="mt-3 inline-block text-sm text-violet-300 hover:text-violet-200"
                >
                  View test order in Orders →
                </a>
              </div>
            ) : (
              <p className="text-sm text-neutral-500">
                Finish a design and click <strong className="text-neutral-300">Add to cart</strong> in the
                preview to see the payload your store plugin would receive here.
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className={emptyCls}>Choose a product and launch the preview to test the designer.</div>
      )}

      <p className="text-xs text-neutral-600 mt-6">
        Note: adding to cart from a preview saves a real design in your asset library and drops a
        clearly-labelled <strong className="text-neutral-400">Test</strong> order into your Orders queue,
        so you can rehearse the full back-end flow (open on a sheet, gang up, mark printed). Delete the
        test order from Orders when you're done.
      </p>
    </WidgetShell>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-neutral-500">{label}</span>
      <span className={`text-neutral-200 ${mono ? "font-mono text-xs break-all text-right" : ""}`}>{value}</span>
    </div>
  );
}
