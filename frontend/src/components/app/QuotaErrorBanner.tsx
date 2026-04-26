import { Link } from "react-router-dom";
import { FormattedApiError } from "../../utils/apiError";

type Props = {
  /** Pass `null` to render nothing. */
  error: FormattedApiError | null;
  /** Optional override for the upgrade link target. Defaults to /pricing. */
  upgradeHref?: string;
  /** When true, render full-bleed inside a card instead of a thin inline banner. */
  variant?: "inline" | "block";
  /** Tailwind classnames to add to the wrapper. */
  className?: string;
};

/**
 * Standard error display that *also* surfaces an "Upgrade" CTA when the
 * backend signalled a quota-exceeded / plan-locked condition. Replaces
 * the bare `<div>{err}</div>` pattern that was stringifying our
 * structured detail bodies into "[object Object]".
 *
 * Use `formatApiError()` from `utils/apiError.ts` to obtain the input.
 */
export default function QuotaErrorBanner({
  error,
  upgradeHref = "/pricing",
  variant = "inline",
  className = "",
}: Props) {
  if (!error) return null;

  const isUpgrade = error.suggestsUpgrade;
  const tone = isUpgrade
    ? "border-amber-500/40 bg-amber-500/10 text-amber-100"
    : "border-rose-500/40 bg-rose-500/10 text-rose-200";

  const padding = variant === "block" ? "p-4 sm:p-5" : "px-4 py-3";

  return (
    <div
      role="alert"
      className={`rounded-lg border ${tone} ${padding} ${className}`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 text-sm leading-relaxed">{error.message}</div>
        {isUpgrade && (
          <Link
            to={upgradeHref}
            className="shrink-0 rounded-md bg-amber-400 hover:bg-amber-300 text-neutral-950 px-3 py-1.5 text-xs font-semibold transition"
          >
            Upgrade →
          </Link>
        )}
      </div>
    </div>
  );
}
