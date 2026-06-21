import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

interface ProofInfo {
  order_id: string;
  customer_ref: string | null;
  line_items: Array<{ qty?: number; options?: { width_mm?: number; height_mm?: number; cut_style?: string } }>;
  amount_total: number;
  currency: string;
  proof_status: string | null;
  thumbnail_url: string | null;
}

type ViewState = "loading" | "review" | "approved" | "rejected" | "error" | "already_responded";

export default function ProofReview() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<ProofInfo | null>(null);
  const [view, setView] = useState<ViewState>("loading");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!token) return;
    fetch(`/api/v1/widget/proof/${token}`)
      .then((r) => {
        if (!r.ok) throw new Error("Not found");
        return r.json();
      })
      .then((data: ProofInfo) => {
        setInfo(data);
        if (data.proof_status === "proof_approved") {
          setView("already_responded");
        } else {
          setView("review");
        }
      })
      .catch(() => setView("error"));
  }, [token]);

  const respond = async (action: "approve" | "reject") => {
    if (action === "reject" && !comment.trim()) {
      setErr("Please explain what changes you'd like.");
      return;
    }
    setSubmitting(true);
    setErr("");
    try {
      const res = await fetch(`/api/v1/widget/proof/${token}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, comment: comment.trim() || null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || "Something went wrong");
      }
      setView(action === "approve" ? "approved" : "rejected");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  if (view === "loading") {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <p style={styles.loading}>Loading proof…</p>
        </div>
      </div>
    );
  }

  if (view === "error") {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.h1}>Proof not found</h1>
          <p style={styles.desc}>This proof link may have expired or is invalid.</p>
        </div>
      </div>
    );
  }

  if (view === "approved") {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <div style={styles.tick}>✓</div>
          <h1 style={styles.h1}>Design approved!</h1>
          <p style={styles.desc}>Thank you — your order will now proceed to printing.</p>
        </div>
      </div>
    );
  }

  if (view === "rejected") {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.h1}>Changes requested</h1>
          <p style={styles.desc}>
            We've received your feedback and will update the design. You'll receive a new proof once it's ready.
          </p>
        </div>
      </div>
    );
  }

  if (view === "already_responded") {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <div style={styles.tick}>✓</div>
          <h1 style={styles.h1}>Already approved</h1>
          <p style={styles.desc}>This design has already been approved and is in the print queue.</p>
        </div>
      </div>
    );
  }

  const itemsDesc = (info?.line_items || []).map((item, i) => {
    const w = item.options?.width_mm;
    const h = item.options?.height_mm;
    const size = w && h ? `${w}mm × ${h}mm` : "—";
    return (
      <div key={i} style={styles.specRow}>
        <span>{item.qty ?? 1}×</span>
        <span>{size}</span>
      </div>
    );
  });

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.logo}>PrintLay</div>
        <h1 style={styles.h1}>Review your design proof</h1>
        <p style={styles.desc}>
          Please review your design below and either approve it for printing or request changes.
        </p>

        {info?.thumbnail_url && (
          <div style={styles.thumbWrap}>
            <img src={info.thumbnail_url} alt="Design preview" style={styles.thumb} />
          </div>
        )}

        <div style={styles.specs}>
          <h3 style={styles.specTitle}>Order details</h3>
          {itemsDesc}
          <div style={styles.specRow}>
            <span>Total</span>
            <span style={{ fontWeight: 700 }}>
              {info?.currency} {info?.amount_total.toFixed(2)}
            </span>
          </div>
        </div>

        {err && <p style={styles.error}>{err}</p>}

        <div style={styles.actions}>
          <button
            style={styles.btnApprove}
            onClick={() => respond("approve")}
            disabled={submitting}
          >
            {submitting ? "Submitting…" : "Approve this design"}
          </button>

          <div style={styles.rejectSection}>
            <textarea
              style={styles.textarea}
              placeholder="Describe the changes you need…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
            />
            <button
              style={styles.btnReject}
              onClick={() => respond("reject")}
              disabled={submitting}
            >
              {submitting ? "Submitting…" : "Request changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#f8fafc",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
  },
  card: {
    background: "#fff",
    borderRadius: 20,
    padding: 32,
    maxWidth: 520,
    width: "100%",
    boxShadow: "0 4px 24px rgba(0,0,0,0.06)",
    textAlign: "center" as const,
  },
  logo: {
    fontSize: 14,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: "#8b5cf6",
    marginBottom: 16,
  },
  h1: { fontSize: 22, fontWeight: 800, color: "#0f172a", margin: "0 0 8px" },
  desc: { fontSize: 14, color: "#64748b", margin: "0 0 20px", lineHeight: 1.5 },
  loading: { color: "#64748b", fontSize: 14 },
  tick: { fontSize: 48, color: "#16a34a", marginBottom: 12 },
  thumbWrap: {
    margin: "0 auto 20px",
    borderRadius: 12,
    overflow: "hidden",
    border: "1px solid #e2e8f0",
  },
  thumb: { width: "100%", maxHeight: 300, objectFit: "contain" as const, display: "block" },
  specs: {
    textAlign: "left" as const,
    background: "#f8fafc",
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
    border: "1px solid #e2e8f0",
  },
  specTitle: { fontSize: 13, fontWeight: 700, margin: "0 0 8px", color: "#334155" },
  specRow: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 14,
    color: "#475569",
    padding: "4px 0",
  },
  error: { color: "#dc2626", fontSize: 13, margin: "8px 0" },
  actions: { display: "flex", flexDirection: "column" as const, gap: 16 },
  btnApprove: {
    width: "100%",
    padding: "14px 24px",
    background: "#16a34a",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    fontSize: 16,
    fontWeight: 700,
    cursor: "pointer",
  },
  rejectSection: { display: "flex", flexDirection: "column" as const, gap: 8 },
  textarea: {
    width: "100%",
    border: "1px solid #e2e8f0",
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    fontFamily: "inherit",
    resize: "vertical" as const,
  },
  btnReject: {
    width: "100%",
    padding: "12px 24px",
    background: "#fff",
    color: "#dc2626",
    border: "1px solid #fecaca",
    borderRadius: 10,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
};
