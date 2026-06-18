import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import WidgetShell, { card } from "./WidgetShell";
import { listProducts, listKeys, listOrders, Product } from "../../api/widget";

export default function WidgetHub() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [keyCount, setKeyCount] = useState<number | null>(null);
  const [orderCount, setOrderCount] = useState<number | null>(null);

  useEffect(() => {
    listProducts().then(setProducts).catch(() => setProducts([]));
    listKeys().then((k) => setKeyCount(k.filter((x) => !x.revoked_at).length)).catch(() => setKeyCount(0));
    listOrders("ready_to_print").then((o) => setOrderCount(o.length)).catch(() => setOrderCount(0));
  }, []);

  const steps = [
    {
      n: 1,
      title: "Set up pricing",
      body: "Create a pricing profile — your media width, price per metre, margin and any volume discounts. The widget prices designs from this.",
      to: "/app/widget/pricing",
      cta: "Pricing profiles",
    },
    {
      n: 2,
      title: "Create a product",
      body: "Define a sticker product: which cut styles customers can pick, size limits, material and finish options, and the pricing profile it uses.",
      to: "/app/widget/products",
      cta: "Products",
    },
    {
      n: 3,
      title: "Test it live",
      body: "Open the live preview to design a sticker exactly as your customers will — before you wire up any store plugin.",
      to: "/app/widget/preview",
      cta: "Live preview",
    },
    {
      n: 4,
      title: "Connect your store",
      body: "Create an API key and add the WooCommerce/Shopify plugin. Paid orders land in your print queue, ready to gang and print.",
      to: "/app/widget/keys",
      cta: "API keys",
    },
  ];

  return (
    <WidgetShell
      title="Sticker widget"
      subtitle="Let customers design their own stickers on your store — priced automatically and delivered to your print queue."
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        <Stat label="Products" value={products?.length ?? "—"} to="/app/widget/products" />
        <Stat label="Active keys" value={keyCount ?? "—"} to="/app/widget/keys" />
        <Stat label="Ready to print" value={orderCount ?? "—"} to="/app/widget/orders" accent />
        <Stat
          label="Try it"
          value="Preview →"
          to={products && products.length ? "/app/widget/preview" : "/app/widget/products"}
        />
      </div>

      <h2 className="text-xs uppercase tracking-widest text-neutral-500 mb-3">Get started</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {steps.map((s) => (
          <Link key={s.n} to={s.to} className={`${card} block hover:border-neutral-700 transition`}>
            <div className="flex items-center gap-3 mb-2">
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-violet-500/15 text-violet-300 text-sm font-semibold">
                {s.n}
              </span>
              <h3 className="font-semibold">{s.title}</h3>
            </div>
            <p className="text-sm text-neutral-400">{s.body}</p>
            <span className="inline-block mt-3 text-sm text-violet-300">{s.cta} →</span>
          </Link>
        ))}
      </div>
    </WidgetShell>
  );
}

function Stat({
  label,
  value,
  to,
  accent,
}: {
  label: string;
  value: string | number;
  to: string;
  accent?: boolean;
}) {
  return (
    <Link
      to={to}
      className={`rounded-xl border p-4 transition hover:border-neutral-600 ${
        accent ? "border-violet-500/40 bg-violet-500/10" : "border-neutral-800 bg-neutral-950/40"
      }`}
    >
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-bold tracking-tight text-white">{value}</div>
    </Link>
  );
}
