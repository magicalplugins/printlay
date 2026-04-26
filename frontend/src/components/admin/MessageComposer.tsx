import { useEffect, useState } from "react";
import {
  getMessagingStatus,
  MessageResponse,
  MessagingStatus,
  Segment,
  sendAdminMessage,
} from "../../api/admin";

const SEGMENTS: { id: Segment; label: string; hint: string }[] = [
  { id: "all", label: "Everyone", hint: "All active users" },
  {
    id: "active_subscribers",
    label: "Active subscribers",
    hint: "Paying users on a current plan",
  },
  {
    id: "trialing",
    label: "On trial",
    hint: "Trial users — ideal for upgrade nudges",
  },
  {
    id: "dropouts",
    label: "Drop-offs",
    hint: "Canceled, past-due, or expired trial — worth re-engaging",
  },
  {
    id: "expiring_30d",
    label: "Renewing within 30 days",
    hint: "Friendly renewal nudge before next charge",
  },
  {
    id: "most_active_30d",
    label: "Most active (last 30d)",
    hint: "Power users — case studies, beta testers",
  },
  {
    id: "stuck_signup",
    label: "Signed up · no template",
    hint: "Onboarding stuck after >7 days",
  },
  {
    id: "stuck_template",
    label: "Template · no PDF",
    hint: "Made templates but never generated",
  },
];

export function MessageComposer({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<MessagingStatus | null>(null);
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [segment, setSegment] = useState<Segment>("all");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<MessageResponse | null>(null);
  const [result, setResult] = useState<MessageResponse | null>(null);

  useEffect(() => {
    getMessagingStatus()
      .then(setStatus)
      .catch((e) => setErr(String(e)));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function doDryRun() {
    setBusy(true);
    setErr(null);
    setPreview(null);
    setResult(null);
    try {
      const res = await sendAdminMessage({
        segment,
        channel,
        subject: channel === "email" ? subject : undefined,
        body,
        dry_run: true,
      });
      setPreview(res);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doSend() {
    if (!preview) return;
    if (
      !confirm(
        `Send this ${channel.toUpperCase()} to ${preview.recipients_total} recipient(s)? This cannot be undone.`
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await sendAdminMessage({
        segment,
        channel,
        subject: channel === "email" ? subject : undefined,
        body,
        dry_run: false,
      });
      setResult(res);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  const channelOk =
    channel === "email"
      ? status?.email_configured
      : status?.sms_configured;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-2xl bg-neutral-950 border border-neutral-800 rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[90vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-900">
          <div>
            <div className="font-semibold">Compose bulk message</div>
            <div className="text-xs text-neutral-500">
              Send email or SMS to a saved segment. Always dry-run first.
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-600"
          >
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Channel */}
          <div>
            <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5">
              Channel
            </div>
            <div className="flex rounded-md border border-neutral-800 overflow-hidden w-fit">
              {(["email", "sms"] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => {
                    setChannel(c);
                    setPreview(null);
                    setResult(null);
                  }}
                  className={`px-4 h-9 text-xs font-medium uppercase tracking-widest ${
                    channel === c
                      ? "bg-violet-500/15 text-violet-200"
                      : "text-neutral-400 hover:bg-neutral-900"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
            {status && !channelOk && (
              <div className="mt-1.5 text-[11px] text-amber-300">
                {channel === "email"
                  ? "RESEND_API_KEY not set — set it via fly secrets to enable."
                  : "Twilio credentials not set — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER."}
              </div>
            )}
          </div>

          {/* Segment */}
          <div>
            <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5">
              Recipient segment
            </div>
            <div className="grid sm:grid-cols-2 gap-2">
              {SEGMENTS.map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setSegment(s.id);
                    setPreview(null);
                    setResult(null);
                  }}
                  className={`text-left rounded-lg border px-3 py-2 text-sm transition ${
                    segment === s.id
                      ? "border-violet-500/60 bg-violet-500/10 text-violet-100"
                      : "border-neutral-800 hover:border-neutral-600"
                  }`}
                >
                  <div className="font-medium">{s.label}</div>
                  <div className="text-[11px] text-neutral-500 mt-0.5">
                    {s.hint}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Compose */}
          {channel === "email" && (
            <div>
              <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5">
                Subject
              </div>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={200}
                placeholder="A short, clear subject line"
                className="w-full h-10 rounded-lg border border-neutral-800 bg-neutral-950 px-3 text-sm outline-none focus:border-violet-500"
              />
            </div>
          )}

          <div>
            <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5">
              Body{" "}
              <span className="text-neutral-600 normal-case tracking-normal">
                ({body.length} chars
                {channel === "sms" && body.length > 160
                  ? `, ~${Math.ceil(body.length / 160)} SMS segments`
                  : ""}
                )
              </span>
            </div>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              maxLength={10000}
              placeholder={
                channel === "email"
                  ? "Plain text. Keep it short and to the point."
                  : "Plain text. Stay under 160 chars to avoid multi-segment costs."
              }
              className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-violet-500 font-mono"
            />
          </div>

          {err && (
            <div className="rounded-md border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
              {err}
            </div>
          )}

          {preview && !result && (
            <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-4 space-y-2">
              <div className="text-sm">
                <span className="font-semibold text-violet-200">
                  {preview.recipients_total} recipient
                  {preview.recipients_total === 1 ? "" : "s"}
                </span>{" "}
                <span className="text-neutral-400">
                  in segment <code>{preview.segment}</code>
                </span>
              </div>
              {preview.results.length > 0 && (
                <details className="text-xs text-neutral-400">
                  <summary className="cursor-pointer hover:text-neutral-200">
                    Preview list ({preview.results.length} shown)
                  </summary>
                  <ul className="mt-2 space-y-0.5 max-h-40 overflow-y-auto pl-3">
                    {preview.results.map((r, i) => (
                      <li key={i}>{r.recipient}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {result && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-2">
              <div className="text-sm">
                <span className="font-semibold text-emerald-200">
                  Sent {result.sent} / {result.recipients_total}
                </span>
                {result.failed > 0 && (
                  <span className="ml-2 text-rose-300">
                    · {result.failed} failed
                  </span>
                )}
              </div>
              {result.failed > 0 && (
                <details className="text-xs text-rose-200">
                  <summary className="cursor-pointer">Failures</summary>
                  <ul className="mt-2 space-y-0.5 pl-3">
                    {result.results
                      .filter((r) => !r.ok)
                      .map((r, i) => (
                        <li key={i}>
                          {r.recipient} — {r.error}
                        </li>
                      ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-neutral-900 flex items-center justify-between gap-3">
          <button
            onClick={doDryRun}
            disabled={
              busy ||
              !body.trim() ||
              (channel === "email" && !subject.trim())
            }
            className="rounded-lg border border-neutral-700 px-4 h-10 text-sm hover:border-neutral-500 disabled:opacity-40"
          >
            {busy && !preview && !result ? "Resolving…" : "Preview recipients"}
          </button>
          <button
            onClick={doSend}
            disabled={busy || !preview || !channelOk || !!result}
            className="rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 px-5 h-10 text-sm font-semibold text-white disabled:opacity-40 hover:from-violet-400 hover:to-fuchsia-400"
            title={
              !preview
                ? "Run a preview first"
                : !channelOk
                  ? "Channel not configured"
                  : "Send for real"
            }
          >
            {busy && preview ? "Sending…" : `Send to ${preview?.recipients_total ?? "?"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
