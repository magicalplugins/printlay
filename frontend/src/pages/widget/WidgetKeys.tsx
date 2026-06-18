import { useEffect, useState } from "react";
import WidgetShell, { btnPrimary, btnDanger, card, emptyCls, inputCls } from "./WidgetShell";
import { ApiKey, ApiKeyCreated, createKey, listKeys, revokeKey } from "../../api/widget";
import { apiErrMessage } from "../../api/client";

export default function WidgetKeys() {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => listKeys().then(setKeys).catch((e) => setErr(apiErrMessage(e)));
  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    setCreating(true);
    setErr(null);
    try {
      const k = await createKey(name.trim() || "API key");
      setCreated(k);
      setName("");
      load();
    } catch (e) {
      setErr(apiErrMessage(e));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    if (!confirm("Revoke this key? Any plugin using it will stop working immediately.")) return;
    try {
      await revokeKey(id);
      load();
    } catch (e) {
      setErr(apiErrMessage(e));
    }
  };

  return (
    <WidgetShell
      title="API keys"
      subtitle="Your store plugin uses an API key to open the designer and submit orders. Treat it like a password."
    >
      {err && <div className="text-rose-400 text-sm mb-4">{err}</div>}

      {created && (
        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-5 mb-6">
          <div className="text-sm font-medium text-emerald-200 mb-2">
            Key created — copy it now. You won't be able to see it again.
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-lg bg-neutral-950 border border-neutral-800 px-3 py-2 text-sm text-neutral-100 break-all">
              {created.plaintext}
            </code>
            <button
              className={btnPrimary}
              onClick={() => navigator.clipboard?.writeText(created.plaintext)}
            >
              Copy
            </button>
          </div>
          <button className="mt-3 text-xs text-neutral-400 hover:text-white" onClick={() => setCreated(null)}>
            Done
          </button>
        </div>
      )}

      <div className={`${card} mb-6`}>
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs uppercase tracking-wider text-neutral-500 mb-1.5">
              New key name
            </label>
            <input
              className={inputCls}
              placeholder="e.g. My WooCommerce store"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <button className={btnPrimary} disabled={creating} onClick={create}>
            {creating ? "Creating…" : "Create key"}
          </button>
        </div>
      </div>

      {keys === null ? (
        <div className="text-neutral-500 text-sm">Loading…</div>
      ) : keys.length === 0 ? (
        <div className={emptyCls}>No API keys yet. Create one to connect a store.</div>
      ) : (
        <div className="rounded-2xl border border-neutral-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-neutral-950/80 text-neutral-500 text-xs uppercase tracking-widest">
              <tr>
                <th className="text-left font-normal px-4 py-2">Name</th>
                <th className="text-left font-normal px-4 py-2">Key</th>
                <th className="text-left font-normal px-4 py-2">Last used</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-900">
              {keys.map((k) => (
                <tr key={k.id} className={k.revoked_at ? "opacity-50" : ""}>
                  <td className="px-4 py-2.5 font-medium">{k.name}</td>
                  <td className="px-4 py-2.5 font-mono text-neutral-400">{k.prefix}…</td>
                  <td className="px-4 py-2.5 text-neutral-400">
                    {k.revoked_at
                      ? "Revoked"
                      : k.last_used_at
                      ? new Date(k.last_used_at).toLocaleDateString()
                      : "Never"}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {!k.revoked_at && (
                      <button className={btnDanger} onClick={() => revoke(k.id)}>
                        Revoke
                      </button>
                    )}
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
