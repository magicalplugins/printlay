import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { submitLead } from "../api/leads";
import { useMe } from "../auth/MeProvider";

/**
 * Floating chat-style contact widget. Sits bottom-right on every page.
 *
 * Flow:
 *   collapsed pill → click → expanded chat-style panel with the
 *   "usually replies within 6 hours" greeting → name/email/message
 *   form → sent confirmation → auto-collapse after a delay.
 *
 * Hidden on admin pages (admins don't need to message themselves) and
 * inside the locked overlay / profile-setup flow (would clash with the
 * forced modal). Logged-in users have their email pre-filled.
 *
 * Lives at z-[45] so it sits above the app header (z-30) and landing
 * nav (z-40) but below modals (z-50).
 */
export default function LeadChatWidget() {
  const { me } = useMe();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const nameRef = useRef<HTMLInputElement | null>(null);
  const messageRef = useRef<HTMLTextAreaElement | null>(null);

  // Pre-fill from the logged-in user once `me` arrives.
  useEffect(() => {
    if (me?.email && !email) setEmail(me.email);
    if (me?.company_name && !name) setName(me.company_name);
  }, [me, email, name]);

  // Focus the first empty field exactly once per open. Depending on `name`
  // here would re-fire on every keystroke and snatch focus mid-type, so we
  // snapshot which field to focus on the open transition only.
  useEffect(() => {
    if (!open) return;
    const target = name ? messageRef.current : nameRef.current;
    const t = window.setTimeout(() => target?.focus(), 50);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Auto-close 4s after a successful send (gives time to read the confirm).
  useEffect(() => {
    if (!sent) return;
    const t = window.setTimeout(() => {
      setOpen(false);
      // Reset for next time after the panel finishes collapsing.
      window.setTimeout(() => {
        setSent(false);
        setMessage("");
      }, 300);
    }, 4000);
    return () => window.clearTimeout(t);
  }, [sent]);

  // Close on Escape when open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const hidden = useMemo(() => {
    // Don't show inside admin (would be noise for the responder) or
    // during the forced profile-setup screen.
    if (pathname.startsWith("/app/admin")) return true;
    if (pathname.startsWith("/profile-setup")) return true;
    if (pathname.startsWith("/login") || pathname.startsWith("/register"))
      return true;
    // Hide during "focus work" — designing templates, programming or
    // filling jobs. The widget would obscure the canvas / drop targets
    // and the user is mid-task, not browsing. List pages (/app/templates,
    // /app/jobs) and the dashboard stay visible.
    if (pathname === "/app/templates/new") return true;
    if (/^\/app\/templates\/[^/]+$/.test(pathname)) return true; // designer
    if (pathname === "/app/jobs/new") return true;
    if (/^\/app\/jobs\/[^/]+\/(program|fill)$/.test(pathname)) return true;
    return false;
  }, [pathname]);

  if (hidden) return null;

  const canSend =
    name.trim().length > 0 &&
    /.+@.+\..+/.test(email) &&
    message.trim().length > 0 &&
    !busy;

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!canSend) return;
    setBusy(true);
    setErr(null);
    try {
      await submitLead({
        name: name.trim(),
        email: email.trim(),
        message: message.trim(),
        page_url:
          typeof window !== "undefined" ? window.location.href : undefined,
      });
      setSent(true);
    } catch (e) {
      setErr(
        e instanceof Error && e.message === "429"
          ? "You've sent a lot of messages — please try again in an hour."
          : "Could not send. Please try again."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed bottom-5 right-5 z-[45] flex flex-col items-end gap-3 print:hidden">
      {open && (
        <div
          role="dialog"
          aria-label="Chat with the PrintLay team"
          className="w-[340px] max-w-[calc(100vw-2.5rem)] rounded-2xl border border-neutral-800 bg-neutral-950/95 backdrop-blur shadow-2xl shadow-violet-500/10 overflow-hidden animate-[slideUp_180ms_ease-out]"
          style={{
            // Inline keyframe so we don't need a Tailwind config change.
            // The animation class above references this name; Tailwind
            // arbitrary-value resolves it at build time.
            animation: "slideUp 180ms ease-out",
          }}
        >
          <style>{`@keyframes slideUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}`}</style>

          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-800 bg-gradient-to-br from-violet-500/10 to-fuchsia-500/5">
            <div className="relative h-9 w-9 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center text-white font-semibold text-sm shrink-0">
              P
              <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-emerald-400 border-2 border-neutral-950" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-neutral-100">
                PrintLay Team
              </div>
              <div className="text-[11px] text-neutral-400">
                Usually replies within 6 hours
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close chat"
              className="rounded-md p-1 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/60 transition"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          {/* Body */}
          {sent ? (
            <div className="px-5 py-8 text-center">
              <div className="mx-auto h-10 w-10 rounded-full bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center mb-3">
                <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
                  <path
                    d="M4 9.5l3 3 7-7"
                    stroke="rgb(110, 231, 183)"
                    strokeWidth="2"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <p className="text-sm font-semibold text-neutral-100">
                Message sent
              </p>
              <p className="mt-1 text-xs text-neutral-400">
                Thanks {name.split(" ")[0] || "there"} — we'll reply to{" "}
                <span className="text-neutral-200">{email}</span> within a few
                hours.
              </p>
            </div>
          ) : (
            <>
              {/* Greeting bubble */}
              <div className="px-4 pt-4 pb-2">
                <div className="inline-block max-w-[85%] rounded-2xl rounded-tl-sm bg-neutral-900 border border-neutral-800 px-3.5 py-2.5 text-sm text-neutral-200">
                  Hi! Got a question or want a quick demo?{" "}
                  <span className="text-neutral-400">
                    Pop your details below and we'll get back to you soon.
                  </span>
                </div>
              </div>

              {/* Form */}
              <form onSubmit={handleSend} className="px-4 pb-4 pt-2 space-y-2">
                <input
                  ref={nameRef}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  maxLength={120}
                  required
                  style={{ fontSize: 16 }}
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 outline-none focus:border-violet-500/60"
                />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@email.com"
                  maxLength={320}
                  required
                  style={{ fontSize: 16 }}
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 outline-none focus:border-violet-500/60"
                />
                <textarea
                  ref={messageRef}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="How can we help?"
                  rows={3}
                  maxLength={5000}
                  required
                  style={{ fontSize: 16 }}
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 outline-none focus:border-violet-500/60 resize-none"
                />

                {err && (
                  <p className="text-xs text-rose-300" role="alert">
                    {err}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={!canSend}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 px-4 h-10 text-sm font-semibold text-white shadow-lg shadow-violet-500/20 hover:from-violet-400 hover:to-fuchsia-400 disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  {busy ? (
                    <>
                      <span className="h-3.5 w-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                      Sending…
                    </>
                  ) : (
                    <>
                      Send
                      <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden>
                        <path
                          d="M1 1l12 6-12 6 3-6L1 1z"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </>
                  )}
                </button>

                <p className="text-[10px] text-neutral-500 text-center pt-1">
                  We'll only use your email to reply — no marketing spam.
                </p>
              </form>
            </>
          )}
        </div>
      )}

      {/* Trigger pill */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? "Close chat" : "Open chat — usually replies in 6 hours"}
        className={`group inline-flex items-center gap-2 rounded-full h-12 shadow-xl shadow-violet-500/30 transition-all ${
          open
            ? "bg-neutral-900 border border-neutral-700 px-4"
            : "bg-gradient-to-r from-violet-500 to-fuchsia-500 hover:from-violet-400 hover:to-fuchsia-400 pl-3 pr-4"
        }`}
      >
        {open ? (
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
            <path
              d="M4 4l10 10M14 4L4 14"
              stroke="white"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <span className="relative flex h-8 w-8 items-center justify-center rounded-full bg-white/15">
            <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden>
              <path
                d="M3 4.5a2 2 0 012-2h8a2 2 0 012 2v6a2 2 0 01-2 2H7l-3.5 3v-3H5a2 2 0 01-2-2v-6z"
                fill="white"
              />
            </svg>
            <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-400 border-2 border-violet-500" />
          </span>
        )}
        <span className="text-sm font-semibold text-white">
          {open ? "Close" : "Chat with us"}
        </span>
      </button>
    </div>
  );
}
