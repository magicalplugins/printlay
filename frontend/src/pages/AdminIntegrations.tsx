import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  IntegrationSetting,
  IntegrationsResponse,
  IntegrationTestResult,
  getIntegrations,
  getGenerationSettings,
  updateGenerationSettings,
  setIntegration,
  testIntegration,
} from "../api/admin";
import { useMe } from "../auth/MeProvider";

/* ─────────────────────────────────────────────────────────────────────
   Admin Integrations — paste / rotate third-party credentials without
   touching `fly secrets`. Values are encrypted at rest (Fernet) with
   the APP_SECRETS_MASTER_KEY Fly secret. Plaintext is never sent back
   to the browser; we render a "set / not set" badge with a Reveal/Clear
   action and a "Test" button that fires a real send.

   Layout: two stacked cards (Email · SMS) so the form stays scannable
   and the test affordance is right next to the inputs it tests.
   ───────────────────────────────────────────────────────────────────── */

type FieldDef = {
  key: string;
  label: string;
  type?: "text" | "password" | "email" | "tel";
  placeholder?: string;
  hint?: string;
};

const EMAIL_FIELDS: FieldDef[] = [
  {
    key: "smtp2go.api_key",
    label: "SMTP2GO API key",
    type: "password",
    placeholder: "api-XXXXXXXX…",
    hint: "Settings → API Keys in SMTP2GO. Needs Send Emails, Activity, Statistics, Suppressions.",
  },
  {
    key: "smtp2go.from_email",
    label: "SMTP2GO sender",
    type: "text",
    placeholder: 'Printlay <info@printlay.co.uk>',
    hint: "Must be on a domain you've verified in SMTP2GO → Sender Domains.",
  },
];

const SMS_FIELDS: FieldDef[] = [
  {
    key: "twilio.account_sid",
    label: "Twilio Account SID",
    type: "text",
    placeholder: "AC…",
  },
  {
    key: "twilio.auth_token",
    label: "Twilio Auth Token",
    type: "password",
    placeholder: "32-char hex",
    hint: "Treat this as a password — rotate in the Twilio console if it ever leaks.",
  },
  {
    key: "twilio.from_number",
    label: "Twilio From number",
    type: "tel",
    placeholder: "+447700900000",
    hint: "E.164 format (no spaces). A Twilio long-code, short-code, or Messaging Service SID.",
  },
];

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function AdminIntegrations() {
  const { me } = useMe();
  const [data, setData] = useState<IntegrationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setData(await getIntegrations());
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const settingMap = useMemo(() => {
    const m: Record<string, IntegrationSetting> = {};
    (data?.settings ?? []).forEach((s) => {
      m[s.key] = s;
    });
    return m;
  }, [data]);

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12 text-neutral-400 text-sm">
        Loading integrations…
      </div>
    );
  }
  if (err) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12 text-rose-300 text-sm">
        Couldn't load integrations: {err}
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
      <header>
        <div className="text-xs uppercase tracking-widest text-neutral-500 mb-1">
          <Link to="/app/admin" className="hover:text-neutral-300">
            ← Admin
          </Link>
        </div>
        <h1 className="text-3xl font-bold tracking-tight">Integrations</h1>
        <p className="text-neutral-500 text-sm mt-1 max-w-xl">
          Connect Printlay to your email and SMS providers. Credentials
          are encrypted at rest — even a DB dump won't expose them.
        </p>
      </header>

      {!data.encryption_available && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="text-sm font-semibold text-amber-200">
            Encrypted storage is unavailable.
          </div>
          <p className="text-xs text-amber-200/80 mt-1 leading-relaxed">
            Set <code className="text-amber-100 bg-amber-500/10 rounded px-1">APP_SECRETS_MASTER_KEY</code>{" "}
            via <code className="text-amber-100 bg-amber-500/10 rounded px-1">fly secrets set</code> so this page
            can save values. The form is read-only until then; the app
            will keep using env-var credentials from your Fly secrets.
          </p>
        </div>
      )}

      <IntegrationCard
        title="Email"
        subtitle="Used for invite emails, bulk outreach, and trial-ending nudges."
        statusLabel={
          data.email_configured ? (
            <>
              Active ·{" "}
              <span className="font-semibold capitalize">
                {data.email_provider}
              </span>
            </>
          ) : (
            "Not configured"
          )
        }
        statusOk={data.email_configured}
        testChannel="email"
        defaultTestRecipient={me?.email ?? ""}
        fields={EMAIL_FIELDS}
        settingMap={settingMap}
        canEdit={data.encryption_available}
        onReload={load}
      />

      <IntegrationCard
        title="SMS"
        subtitle="Used for SMS outreach via Twilio. Optional."
        statusLabel={data.sms_configured ? "Active · Twilio" : "Not configured"}
        statusOk={data.sms_configured}
        testChannel="sms"
        defaultTestRecipient={me?.phone ?? ""}
        fields={SMS_FIELDS}
        settingMap={settingMap}
        canEdit={data.encryption_available}
        onReload={load}
      />

      <GenerationSettingsCard />
    </div>
  );
}

function IntegrationCard({
  title,
  subtitle,
  statusLabel,
  statusOk,
  testChannel,
  defaultTestRecipient,
  fields,
  settingMap,
  canEdit,
  onReload,
}: {
  title: string;
  subtitle: string;
  statusLabel: React.ReactNode;
  statusOk: boolean;
  testChannel: "email" | "sms";
  defaultTestRecipient: string;
  fields: FieldDef[];
  settingMap: Record<string, IntegrationSetting>;
  canEdit: boolean;
  onReload: () => Promise<void> | void;
}) {
  const [testTo, setTestTo] = useState(defaultTestRecipient);
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(
    null
  );
  const [testBusy, setTestBusy] = useState(false);

  // Keep the test field in sync with the user's profile email/phone once
  // the parent loads them.
  useEffect(() => {
    if (!testTo && defaultTestRecipient) setTestTo(defaultTestRecipient);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultTestRecipient]);

  async function onTest(e: FormEvent) {
    e.preventDefault();
    if (!testTo.trim()) return;
    setTestResult(null);
    setTestBusy(true);
    try {
      setTestResult(await testIntegration(testChannel, testTo.trim()));
    } catch (err) {
      setTestResult({ ok: false, error: String(err), provider: null });
    } finally {
      setTestBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-950/60 overflow-hidden">
      <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-neutral-900">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="text-xs text-neutral-500 mt-0.5">{subtitle}</p>
        </div>
        <span
          className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium border shrink-0 ${
            statusOk
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
              : "bg-neutral-800/40 border-neutral-700 text-neutral-400"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              statusOk ? "bg-emerald-400" : "bg-neutral-500"
            }`}
          />
          {statusLabel}
        </span>
      </div>

      <div className="divide-y divide-neutral-900">
        {fields.map((f) => (
          <CredentialField
            key={f.key}
            field={f}
            setting={settingMap[f.key]}
            canEdit={canEdit}
            onSaved={onReload}
          />
        ))}
      </div>

      <div className="px-5 py-4 bg-neutral-950/80 border-t border-neutral-900">
        <form onSubmit={onTest} className="flex items-center gap-2 flex-wrap">
          <div className="text-xs text-neutral-500 mr-1">
            Send a test {testChannel === "email" ? "email" : "SMS"} to
          </div>
          <input
            type={testChannel === "email" ? "email" : "tel"}
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder={
              testChannel === "email" ? "you@example.com" : "+447700900000"
            }
            className="flex-1 min-w-[200px] rounded-md border border-neutral-800 bg-neutral-900 px-3 h-9 text-sm outline-none focus:border-neutral-600"
          />
          <button
            type="submit"
            disabled={testBusy || !statusOk || !testTo.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-r from-violet-500 to-fuchsia-500 px-4 h-9 text-xs font-semibold text-white hover:from-violet-400 hover:to-fuchsia-400 disabled:opacity-40"
          >
            {testBusy ? "Sending…" : "Send test"}
          </button>
        </form>
        {testResult && (
          <div
            className={`mt-2 text-xs rounded-md px-3 py-2 ${
              testResult.ok
                ? "bg-emerald-500/10 border border-emerald-500/30 text-emerald-200"
                : "bg-rose-500/10 border border-rose-500/30 text-rose-200"
            }`}
          >
            {testResult.ok ? (
              <>
                ✓ Sent via{" "}
                <span className="font-semibold capitalize">
                  {testResult.provider}
                </span>
                . Check the recipient's inbox / phone.
              </>
            ) : (
              <>✗ {testResult.error}</>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function CredentialField({
  field,
  setting,
  canEdit,
  onSaved,
}: {
  field: FieldDef;
  setting: IntegrationSetting | undefined;
  canEdit: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const isSet = !!setting?.is_set;
  const source = setting?.source ?? "none";
  const [editing, setEditing] = useState(!isSet);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [showValue, setShowValue] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const isPassword = field.type === "password";

  async function onSave() {
    setErr(null);
    setBusy(true);
    try {
      await setIntegration(field.key, value);
      setValue("");
      setEditing(false);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
      await onSaved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onClear() {
    if (!window.confirm(`Clear ${field.label}? The env-var fallback (if any) will take over.`))
      return;
    setBusy(true);
    setErr(null);
    try {
      await setIntegration(field.key, "");
      setEditing(true);
      setValue("");
      await onSaved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-5 py-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <label className="block text-sm font-medium text-neutral-200">
            {field.label}
          </label>
          {field.hint && (
            <p className="text-[11px] text-neutral-500 mt-0.5 leading-relaxed max-w-md">
              {field.hint}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest">
          {isSet ? (
            <span
              className={`px-2 py-0.5 rounded-full border ${
                source === "db"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-300"
              }`}
              title={
                source === "db"
                  ? "Saved here, encrypted in the database."
                  : "Inherited from a Fly secret / env var. Save a new value here to switch to DB management."
              }
            >
              {source === "db" ? "Set · in-product" : "Set · env"}
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded-full border border-neutral-700 text-neutral-500">
              Not set
            </span>
          )}
          {savedFlash && (
            <span className="text-emerald-300 normal-case">Saved ✓</span>
          )}
        </div>
      </div>

      {!editing && isSet && (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <code className="flex-1 min-w-[180px] text-xs font-mono text-neutral-500 bg-neutral-950 border border-neutral-900 rounded px-3 py-2">
            ••••••••{isPassword ? "" : "••••"}
          </code>
          {canEdit && (
            <>
              <button
                type="button"
                onClick={() => {
                  setEditing(true);
                  setValue("");
                  setShowValue(false);
                }}
                className="rounded-md border border-neutral-700 px-3 h-8 text-xs text-neutral-200 hover:border-neutral-500"
              >
                Replace
              </button>
              {source === "db" && (
                <button
                  type="button"
                  onClick={onClear}
                  disabled={busy}
                  className="rounded-md border border-rose-500/40 px-3 h-8 text-xs text-rose-300 hover:bg-rose-500/10 disabled:opacity-40"
                >
                  Clear
                </button>
              )}
            </>
          )}
          {setting?.updated_at && (
            <span className="text-[10px] text-neutral-500">
              Updated {formatRelative(setting.updated_at)}
              {setting.updated_by_email
                ? ` by ${setting.updated_by_email}`
                : ""}
            </span>
          )}
        </div>
      )}

      {editing && canEdit && (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type={isPassword && !showValue ? "password" : "text"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={field.placeholder}
              autoComplete="off"
              spellCheck={false}
              className="flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-3 h-9 text-sm font-mono outline-none focus:border-violet-500/60"
            />
            {isPassword && (
              <button
                type="button"
                onClick={() => setShowValue((s) => !s)}
                className="rounded-md border border-neutral-800 px-3 h-9 text-xs text-neutral-300 hover:border-neutral-600"
              >
                {showValue ? "Hide" : "Show"}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={onSave}
              disabled={busy || !value.trim()}
              className="rounded-md bg-white px-4 h-9 text-xs font-semibold text-neutral-950 hover:bg-neutral-200 disabled:opacity-40"
            >
              {busy ? "Saving…" : isSet ? "Update" : "Save"}
            </button>
            {isSet && (
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setValue("");
                  setErr(null);
                }}
                disabled={busy}
                className="rounded-md border border-neutral-800 px-3 h-9 text-xs text-neutral-400 hover:border-neutral-600 disabled:opacity-40"
              >
                Cancel
              </button>
            )}
          </div>
          {err && (
            <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded px-3 py-2">
              {err}
            </div>
          )}
        </div>
      )}

      {!canEdit && !isSet && (
        <p className="mt-2 text-[11px] text-neutral-500">
          Add the value via{" "}
          <code className="text-neutral-300 bg-neutral-900 rounded px-1">
            fly secrets set
          </code>{" "}
          (storage is read-only until the master key is set).
        </p>
      )}
    </div>
  );
}

function GenerationSettingsCard() {
  const [threshold, setThreshold] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getGenerationSettings()
      .then((s) => setThreshold(s.compression_threshold_mb))
      .catch(() => setThreshold(75));
  }, []);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (threshold == null) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateGenerationSettings({ compression_threshold_mb: threshold });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-base font-semibold text-white">Generation</h3>
          <p className="text-xs text-neutral-500 mt-0.5">
            Controls when the compression prompt appears during PDF generation.
          </p>
        </div>
      </div>
      <form onSubmit={handleSave} className="flex items-end gap-3">
        <div className="flex-1 max-w-xs">
          <label className="text-xs text-neutral-400 block mb-1">
            Compression threshold (MB)
          </label>
          <input
            type="number"
            min={1}
            max={10000}
            value={threshold ?? ""}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="w-full h-9 rounded-md border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-200 focus:border-violet-500 focus:outline-none"
          />
          <p className="text-[11px] text-neutral-600 mt-1">
            Jobs with combined asset size above this will prompt the user to choose full quality or optimised.
          </p>
        </div>
        <button
          type="submit"
          disabled={saving || threshold == null}
          className="h-9 px-4 rounded-md bg-violet-600 text-white text-xs font-medium hover:bg-violet-500 disabled:opacity-40"
        >
          {saving ? "Saving…" : saved ? "Saved" : "Save"}
        </button>
      </form>
      {error && (
        <div className="mt-2 text-xs text-rose-300">{error}</div>
      )}
    </div>
  );
}