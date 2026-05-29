import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";

type ChangelogEntry = {
  id: string;
  title: string;
  body: string;
  tag: string;
  published: boolean;
  published_at: string;
};

const TAGS = ["feature", "improvement", "fix"];

function tagBadge(tag: string) {
  const styles: Record<string, string> = {
    feature: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    improvement: "bg-blue-500/15 text-blue-300 border-blue-500/30",
    fix: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  };
  const cls = styles[tag] ?? "bg-neutral-500/15 text-neutral-300 border-neutral-500/30";
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-[10px] uppercase tracking-widest rounded-full border ${cls}`}
    >
      {tag}
    </span>
  );
}

export default function AdminChangelog() {
  const [entries, setEntries] = useState<ChangelogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Form state
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tag, setTag] = useState("feature");
  const [published, setPublished] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Edit state
  const [editId, setEditId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ items: ChangelogEntry[] }>("/api/admin/changelog");
      setEntries(res.items);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function startEdit(entry: ChangelogEntry) {
    setEditId(entry.id);
    setTitle(entry.title);
    setBody(entry.body);
    setTag(entry.tag);
    setPublished(entry.published);
  }

  function cancelEdit() {
    setEditId(null);
    setTitle("");
    setBody("");
    setTag("feature");
    setPublished(true);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (editId) {
        await api(`/api/admin/changelog/${editId}`, {
          method: "PUT",
          body: JSON.stringify({ title, body, tag, published }),
        });
      } else {
        await api("/api/admin/changelog", {
          method: "POST",
          body: JSON.stringify({ title, body, tag, published }),
        });
      }
      cancelEdit();
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string) {
    if (!window.confirm("Delete this changelog entry?")) return;
    try {
      await api(`/api/admin/changelog/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      alert(`Delete failed: ${e}`);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      <header>
        <div className="text-xs uppercase tracking-widest text-neutral-500 mb-1">
          <Link to="/app/admin" className="hover:text-neutral-300">
            ← Admin
          </Link>
        </div>
        <h1 className="text-3xl font-bold tracking-tight">Changelog</h1>
        <p className="text-neutral-500 text-sm mt-1">
          Manage "What's New" entries shown on the Help page.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-6">
        {/* Composer */}
        <section className="rounded-2xl border border-neutral-800 bg-neutral-950/60 p-5 space-y-4 self-start">
          <h2 className="text-sm font-semibold">
            {editId ? "Edit entry" : "New entry"}
          </h2>
          <form onSubmit={onSubmit} className="space-y-3">
            <div>
              <label className="block text-[11px] uppercase tracking-widest text-neutral-500 mb-1">
                Title
              </label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                placeholder="e.g. Sticker builder now live"
                className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 h-9 text-sm outline-none focus:border-violet-500/60"
              />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-widest text-neutral-500 mb-1">
                Body
              </label>
              <textarea
                required
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                maxLength={5000}
                placeholder="Describe the change..."
                className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-violet-500/60 resize-none"
              />
            </div>
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <label className="block text-[11px] uppercase tracking-widest text-neutral-500 mb-1">
                  Tag
                </label>
                <div className="flex gap-1.5">
                  {TAGS.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTag(t)}
                      className={`px-2.5 h-7 rounded-md text-xs font-medium border transition ${
                        tag === t
                          ? "bg-violet-500/15 border-violet-500/40 text-violet-200"
                          : "border-neutral-800 text-neutral-400 hover:border-neutral-700"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer mt-4">
                <input
                  type="checkbox"
                  checked={published}
                  onChange={(e) => setPublished(e.target.checked)}
                  className="accent-violet-500"
                />
                <span className="text-xs text-neutral-400">Published</span>
              </label>
            </div>

            {err && (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-2 text-xs text-rose-200">
                {err}
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={busy || !title.trim() || !body.trim()}
                className="flex-1 rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 px-4 h-9 text-sm font-semibold text-white hover:from-violet-400 hover:to-fuchsia-400 disabled:opacity-40"
              >
                {busy
                  ? "Saving…"
                  : editId
                  ? "Save changes"
                  : "Publish entry"}
              </button>
              {editId && (
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="rounded-lg border border-neutral-700 px-3 h-9 text-xs text-neutral-300 hover:border-neutral-500"
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        </section>

        {/* List */}
        <section className="space-y-3 min-w-0">
          {loading ? (
            <div className="text-sm text-neutral-500">Loading…</div>
          ) : entries.length === 0 ? (
            <div className="rounded-xl border border-neutral-800 p-8 text-center text-sm text-neutral-500">
              No changelog entries yet. Create one to the left.
            </div>
          ) : (
            <div className="space-y-3">
              {entries.map((entry) => (
                <article
                  key={entry.id}
                  className={`rounded-xl border p-4 space-y-1.5 ${
                    entry.published
                      ? "border-neutral-800 bg-neutral-950/60"
                      : "border-neutral-800/50 bg-neutral-950/30 opacity-60"
                  }`}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    {tagBadge(entry.tag)}
                    {!entry.published && (
                      <span className="text-[10px] uppercase tracking-widest text-neutral-600 border border-neutral-700 rounded-full px-2 py-0.5">
                        Draft
                      </span>
                    )}
                    <span className="text-[11px] text-neutral-500 ml-auto">
                      {new Date(entry.published_at).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </span>
                  </div>
                  <h3 className="text-sm font-semibold text-neutral-100">
                    {entry.title}
                  </h3>
                  <p className="text-xs text-neutral-400 leading-relaxed whitespace-pre-wrap line-clamp-3">
                    {entry.body}
                  </p>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={() => startEdit(entry)}
                      className="text-xs font-medium text-violet-300 hover:text-violet-200"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => onDelete(entry.id)}
                      className="text-xs font-medium text-rose-400 hover:text-rose-300"
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
