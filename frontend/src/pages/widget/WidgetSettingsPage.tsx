import { useEffect, useState } from "react";
import WidgetShell, { btnPrimary, btnSecondary, card, inputCls } from "./WidgetShell";
import {
  getWidgetSettings,
  rotateWebhookSecret,
  updateWidgetSettings,
} from "../../api/widget";
import { apiErrMessage } from "../../api/client";

export default function WidgetSettingsPage() {
  const [origins, setOrigins] = useState<string>("");
  const [hasSecret, setHasSecret] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getWidgetSettings()
      .then((s) => {
        setOrigins((s.allowed_origins || []).join("\n"));
        setHasSecret(s.has_webhook_secret);
      })
      .catch((e) => setErr(apiErrMessage(e)));
  }, []);

  const save = async () => {
    setSaving(true);
    setErr(null);
    setSaved(false);
    try {
      const list = origins
        .split(/[\n,]/)
        .map((o) => o.trim())
        .filter(Boolean);
      const s = await updateWidgetSettings(list);
      setOrigins((s.allowed_origins || []).join("\n"));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(apiErrMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const rotate = async () => {
    if (hasSecret && !confirm("Replace the existing webhook secret? Your plugin will need updating.")) return;
    setErr(null);
    try {
      const r = await rotateWebhookSecret();
      setSecret(r.webhook_secret);
      setHasSecret(true);
    } catch (e) {
      setErr(apiErrMessage(e));
    }
  };

  return (
    <WidgetShell
      title="Widget settings"
      subtitle="Where the designer is allowed to run, and the secret that secures your order webhook."
    >
      {err && <div className="text-rose-400 text-sm mb-4">{err}</div>}

      <div className={`${card} mb-6`}>
        <label className="block text-xs uppercase tracking-wider text-neutral-500 mb-1.5">
          Allowed store origins
        </label>
        <p className="text-sm text-neutral-400 mb-3">
          One per line, e.g. <code className="text-neutral-300">https://shop.example.com</code>. Only
          these domains may embed the designer and call the widget API.
        </p>
        <textarea
          className={`${inputCls} min-h-[120px] font-mono`}
          value={origins}
          placeholder="https://your-store.com"
          onChange={(e) => setOrigins(e.target.value)}
        />
        <div className="flex items-center gap-3 mt-3">
          <button className={btnPrimary} disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save origins"}
          </button>
          {saved && <span className="text-sm text-emerald-400">Saved ✓</span>}
        </div>
      </div>

      <div className={card}>
        <label className="block text-xs uppercase tracking-wider text-neutral-500 mb-1.5">
          Order webhook secret
        </label>
        <p className="text-sm text-neutral-400 mb-3">
          Your plugin signs paid-order webhooks with this secret so Printlay can verify them. Keep it
          private.
        </p>
        {secret ? (
          <div className="flex items-center gap-2 mb-3">
            <code className="flex-1 rounded-lg bg-neutral-950 border border-neutral-800 px-3 py-2 text-sm break-all">
              {secret}
            </code>
            <button className={btnPrimary} onClick={() => navigator.clipboard?.writeText(secret)}>
              Copy
            </button>
          </div>
        ) : (
          <p className="text-sm text-neutral-500 mb-3">
            {hasSecret ? "A secret is set (hidden)." : "No secret yet."}
          </p>
        )}
        <button className={btnSecondary} onClick={rotate}>
          {hasSecret ? "Regenerate secret" : "Generate secret"}
        </button>
      </div>
    </WidgetShell>
  );
}
