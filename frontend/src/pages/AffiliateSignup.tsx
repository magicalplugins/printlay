import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { affiliateSignup } from "../api/affiliate";

export default function AffiliateSignup() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ref_code: string; message: string } | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await affiliateSignup(email.trim(), name.trim() || undefined);
      setResult(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const shareLink = result
    ? `${window.location.origin}/api/affiliate/click/${result.ref_code}`
    : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-950 via-gray-900 to-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link to="/" className="inline-block">
            <h1 className="text-2xl font-bold text-white tracking-tight">
              Print<span className="text-violet-400">Lay</span>
            </h1>
          </Link>
          <p className="mt-2 text-gray-400 text-sm">Affiliate Programme</p>
        </div>

        {result ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-6 text-center space-y-4">
            <div className="text-emerald-400 text-lg font-semibold">
              You're in!
            </div>
            <p className="text-gray-300 text-sm">{result.message}</p>
            <div className="space-y-2">
              <label className="text-xs text-gray-500 uppercase tracking-wider">
                Your share link
              </label>
              <div className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 break-all select-all">
                {shareLink}
              </div>
              <button
                onClick={() => navigator.clipboard.writeText(shareLink!)}
                className="text-xs text-violet-400 hover:text-violet-300 underline"
              >
                Copy to clipboard
              </button>
            </div>
            <div className="pt-4 border-t border-gray-800">
              <p className="text-xs text-gray-500">
                Earn 20% commission on every customer you refer.
                <br />
                Already have a PrintLay account?{" "}
                <Link to="/login" className="text-violet-400 hover:underline">
                  Log in
                </Link>{" "}
                to see your dashboard.
              </p>
            </div>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-5">
            <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6 space-y-4">
              <div className="text-center mb-2">
                <h2 className="text-lg font-semibold text-white">
                  Join as an Affiliate
                </h2>
                <p className="text-sm text-gray-400 mt-1">
                  Earn 20% commission for every customer you refer to PrintLay.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                  placeholder="you@example.com"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Name <span className="text-gray-600">(optional)</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                  placeholder="Your name or company"
                />
              </div>

              {error && (
                <p className="text-sm text-rose-400">{error}</p>
              )}

              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50 transition-colors"
              >
                {busy ? "Creating..." : "Get my affiliate link"}
              </button>
            </div>

            <p className="text-center text-xs text-gray-500">
              Already a PrintLay customer?{" "}
              <Link to="/login" className="text-violet-400 hover:underline">
                Log in
              </Link>{" "}
              to join from your dashboard instead.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
