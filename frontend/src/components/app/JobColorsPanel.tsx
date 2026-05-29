import { useCallback, useEffect, useRef, useState } from "react";
import {
  ColorProfile,
  ColorSwap,
  createColorProfile,
  getJobColors,
  listColorProfiles,
  rgbCss,
  rgbToHex,
  updateColorProfile,
  updateJobColors,
  type RGB,
} from "../../api/colorProfiles";
import { formatErr } from "../../utils/apiError";
import ColorProfileEditor from "./ColorProfileEditor";
import RgbColorPicker from "./RgbColorPicker";

type Props = {
  jobId: string;
  /** Total number of currently-assigned slots. Used to skip detection
   *  when the job has nothing in it yet. */
  filledSlotCount: number;
  /** Asset IDs in the *current* (possibly unsaved) queue. Detection scans
   *  these so colours appear before the queue is saved. */
  assetIds?: string[];
};

/**
 * Job-page Colors panel.
 *
 * Workflow:
 *   1. Click "Detect colours" -> server scans the assets currently filling
 *      the job's slots and returns every distinct RGB triple.
 *   2. The user adds swaps (either by clicking a detected swatch or via
 *      "+ Add swap manually") which become the job's `color_swaps_draft`.
 *   3. Optionally pick a saved profile from the dropdown - its swaps get
 *      merged with the draft (draft wins on identical sources).
 *   4. Optionally "Save as profile..." promotes the current draft into a
 *      new named ColorProfile (which is then attached to this job, and
 *      becomes available on every other job).
 *   5. At Generate PDF time the backend resolves profile (live) + draft
 *      and rewrites colour operators as DeviceRGB.
 */
export default function JobColorsPanel({
  jobId,
  filledSlotCount,
  assetIds = [],
}: Props) {
  // Stable, de-duplicated key for the current queue assets so the
  // detection effect re-runs whenever the queue changes.
  const assetKey = Array.from(new Set(assetIds)).sort().join(",");
  const hasAssets = assetKey.length > 0 || filledSlotCount > 0;
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [detected, setDetected] = useState<RGB[]>([]);
  const [draft, setDraft] = useState<ColorSwap[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [activeProfile, setActiveProfile] = useState<ColorProfile | null>(null);
  const [profiles, setProfiles] = useState<ColorProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saveAsOpen, setSaveAsOpen] = useState(false);

  // Load the saved state (profile link + draft swaps) immediately on
  // mount so the collapsed header can truthfully say "1 swap active",
  // and reopening the page never looks like the swap was lost.
  // Detection (the expensive storage round-trip that scans asset PDFs
  // for colours) is deferred until the user actually opens the panel.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [state, all] = await Promise.all([
          getJobColors(jobId, { detect: false }),
          listColorProfiles(),
        ]);
        if (cancelled) return;
        setDraft(state.color_swaps_draft);
        setProfileId(state.color_profile_id);
        setActiveProfile(state.profile);
        setProfiles(all);
        setLoaded(true);
      } catch (e) {
        if (!cancelled) setErr(formatErr(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Run colour detection (scans the asset PDFs in storage) once the user
  // opens the panel, and re-run whenever the queue's assets change. We
  // scan the *current* queue (assetKey) so colours appear before saving.
  const [detectedLoaded, setDetectedLoaded] = useState(false);
  const [lastDetectKey, setLastDetectKey] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !hasAssets) return;
    if (detectedLoaded && lastDetectKey === assetKey) return;
    let cancelled = false;
    (async () => {
      setBusy(true);
      setErr(null);
      try {
        const state = await getJobColors(jobId, {
          detect: true,
          assetIds: assetKey ? assetKey.split(",") : undefined,
        });
        if (cancelled) return;
        setDetected(state.detected);
        setDetectedLoaded(true);
        setLastDetectKey(assetKey);
      } catch (e) {
        if (!cancelled) setErr(formatErr(e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, detectedLoaded, lastDetectKey, assetKey, hasAssets, jobId]);

  // Auto-save draft and profile-link to the job whenever they change.
  // Debounced so picker drags don't hammer the API.
  useEffect(() => {
    if (!loaded) return;
    const handle = setTimeout(() => {
      void persistJob();
    }, 500);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, profileId]);

  async function persistJob() {
    try {
      await updateJobColors(jobId, {
        color_profile_id: profileId,
        clear_profile: profileId === null,
        color_swaps_draft: draft,
        clear_draft: draft.length === 0,
      });
    } catch (e) {
      setErr(formatErr(e));
    }
  }

  async function redetect() {
    setBusy(true);
    setErr(null);
    try {
      const state = await getJobColors(jobId, {
        detect: true,
        assetIds: assetKey ? assetKey.split(",") : undefined,
      });
      setDetected(state.detected);
      setDetectedLoaded(true);
      setLastDetectKey(assetKey);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveAsNewProfile(name: string) {
    setBusy(true);
    setErr(null);
    try {
      const p = await createColorProfile({ name, swaps: draft });
      setProfiles((cur) => [p, ...cur].sort((a, b) => a.name.localeCompare(b.name)));
      setProfileId(p.id);
      setActiveProfile(p);
      setDraft([]);
      setSaveAsOpen(false);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  // Inline edits to the attached profile. The PATCH is debounced via a
  // small timer so dragging a colour input doesn't hammer the API; the
  // local state still updates immediately so the UI feels live.
  const profilePatchTimer = useProfilePatchTimer(setActiveProfile, setProfiles);

  function mutateActiveProfile(next: ColorSwap[]) {
    if (!activeProfile) return;
    const updated: ColorProfile = { ...activeProfile, swaps: next };
    setActiveProfile(updated);
    setProfiles((cur) => cur.map((p) => (p.id === updated.id ? updated : p)));
    profilePatchTimer(activeProfile.id, next);
  }

  function updateProfileSwap(idx: number, patch: Partial<ColorSwap>) {
    if (!activeProfile) return;
    mutateActiveProfile(
      activeProfile.swaps.map((s, i) => (i === idx ? { ...s, ...patch } : s))
    );
  }

  function removeProfileSwap(idx: number) {
    if (!activeProfile) return;
    const usedByOthers = activeProfile.job_count > 1;
    if (
      usedByOthers &&
      !confirm(
        `Remove this swap from "${activeProfile.name}"? It will affect ${activeProfile.job_count} jobs that use this profile.`
      )
    )
      return;
    mutateActiveProfile(activeProfile.swaps.filter((_, i) => i !== idx));
  }

  async function pushDraftIntoActiveProfile() {
    if (!activeProfile) return;
    setBusy(true);
    setErr(null);
    try {
      // Overlay draft onto profile.swaps (draft wins on identical source)
      const bySource = new Map<string, ColorSwap>();
      for (const s of activeProfile.swaps) bySource.set(s.source.join(","), s);
      for (const s of draft) bySource.set(s.source.join(","), s);
      const merged = Array.from(bySource.values());
      const updated = await updateColorProfile(activeProfile.id, { swaps: merged });
      setActiveProfile(updated);
      setProfiles((cur) =>
        cur.map((p) => (p.id === updated.id ? updated : p))
      );
      setDraft([]);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  // Effective list = profile.swaps overlaid by draft (draft wins on source).
  const effective = (() => {
    const bySource = new Map<string, ColorSwap>();
    if (activeProfile) {
      for (const s of activeProfile.swaps) bySource.set(s.source.join(","), s);
    }
    for (const s of draft) bySource.set(s.source.join(","), s);
    return Array.from(bySource.values());
  })();

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 backdrop-blur overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-neutral-900/60 transition"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-0.5">
            {effective.slice(0, 4).map((s, i) => (
              <span
                key={i}
                className="h-5 w-5 rounded-sm border border-neutral-700"
                style={{ backgroundColor: rgbCss(s.target) }}
                title={`→ ${rgbToHex(s.target)}`}
              />
            ))}
            {effective.length === 0 && (
              <span
                className="h-5 w-5 rounded-sm border border-dashed border-neutral-700"
                aria-hidden="true"
              />
            )}
          </div>
          <div className="text-left min-w-0">
            <div className="text-xs uppercase tracking-widest text-neutral-500">
              Colour swaps
            </div>
            <div className="text-sm text-neutral-300 mt-0.5 truncate">
              {effective.length === 0
                ? "None — output prints original colours"
                : `${effective.length} swap${effective.length === 1 ? "" : "s"} active${
                    activeProfile ? ` · ${activeProfile.name}` : ""
                  }`}
            </div>
          </div>
        </div>
        <span
          className={`text-neutral-500 text-sm transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          ▾
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4 border-t border-neutral-900 pt-4">
          {err && (
            <div className="rounded-lg bg-rose-500/10 border border-rose-500/30 px-3 py-2 text-xs text-rose-300">
              {err}
            </div>
          )}

          {busy && !detectedLoaded && (
            <div className="flex items-center gap-2 rounded-lg bg-violet-500/10 border border-violet-500/30 px-3 py-2">
              <svg className="animate-spin h-4 w-4 text-violet-400" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
              </svg>
              <span className="text-xs text-violet-300">Detecting colours from assigned assets…</span>
            </div>
          )}

          {/* Profile picker */}
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-neutral-400 font-medium">
              Saved profile:
            </label>
            <select
              value={profileId ?? ""}
              onChange={(e) => {
                const v = e.target.value || null;
                setProfileId(v);
                setActiveProfile(profiles.find((p) => p.id === v) ?? null);
              }}
              disabled={busy}
              className="flex-1 min-w-[10rem] rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm focus:border-violet-500 focus:outline-none disabled:opacity-60"
            >
              <option value="">(none — draft only)</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.swaps.length} swap
                  {p.swaps.length === 1 ? "" : "s"}
                </option>
              ))}
            </select>
          </div>

          {/* Draft swap editor (uses detected colours when available) */}
          <ColorProfileEditor
            swaps={draft}
            onChange={setDraft}
            detected={detected}
          />

          {/* Honest empty-detection hint: distinguishes "nothing filled"
              from "scanned but no swappable colours" (raster art). */}
          {detectedLoaded && detected.length === 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/90">
              {hasAssets
                ? "No swappable colours found in the assigned artwork. Colour swaps only work on vector PDF/SVG art — photo or raster (PNG/JPG) stickers can't be recoloured this way. You can still add a swap manually below."
                : "Fill at least one slot to detect colours."}
            </div>
          )}

          {/* Active profile swaps - rendered below the draft so the user can
              SEE what the attached profile is contributing. Edits here PATCH
              the profile directly (with debounce) and propagate to every
              other job linked to it. */}
          {activeProfile && (
            <ProfileSwapsSection
              profile={activeProfile}
              detected={detected}
              onUpdate={updateProfileSwap}
              onRemove={removeProfileSwap}
            />
          )}

          {/* Bottom action row */}
          <div className="flex items-center justify-between gap-2 flex-wrap pt-1">
            <button
              type="button"
              onClick={redetect}
              disabled={busy || !hasAssets}
              className="text-xs text-violet-300 hover:text-violet-200 disabled:opacity-50"
              title={
                !hasAssets
                  ? "Fill at least one slot first"
                  : "Re-scan assigned assets"
              }
            >
              ↻ Re-detect colours
            </button>
            <div className="flex items-center gap-2">
              {activeProfile && draft.length > 0 && (
                <button
                  type="button"
                  onClick={pushDraftIntoActiveProfile}
                  disabled={busy}
                  className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs hover:border-violet-500 disabled:opacity-50"
                  title={`Push these ${draft.length} draft swap(s) into "${activeProfile.name}" (affects all linked jobs)`}
                >
                  Push to profile
                </button>
              )}
              <button
                type="button"
                onClick={() => setSaveAsOpen(true)}
                disabled={busy || draft.length === 0}
                className="rounded-md bg-emerald-500 text-emerald-950 px-3 py-1.5 text-xs font-semibold hover:bg-emerald-400 disabled:opacity-50"
              >
                Save as profile…
              </button>
            </div>
          </div>

          {busy && detectedLoaded && (
            <div className="text-xs text-neutral-500">Working…</div>
          )}
        </div>
      )}

      {saveAsOpen && (
        <SaveAsProfileModal
          defaultName={`Profile ${profiles.length + 1}`}
          onCancel={() => setSaveAsOpen(false)}
          onSave={saveAsNewProfile}
        />
      )}
    </section>
  );
}

/**
 * Read-mostly list of swaps inherited from the attached profile. Each
 * row can be expanded for inline RGB editing (changes PATCH the profile
 * with debounce) or removed entirely. We render this below the draft
 * editor so the user can see exactly what their profile is contributing
 * - matching the "2 swaps active" header even when their job draft is
 * empty because they already saved everything as a profile.
 */
function ProfileSwapsSection({
  profile,
  detected,
  onUpdate,
  onRemove,
}: {
  profile: ColorProfile;
  detected: RGB[];
  onUpdate: (idx: number, patch: Partial<ColorSwap>) => void;
  onRemove: (idx: number) => void;
}) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [openSide, setOpenSide] = useState<"source" | "target">("target");

  return (
    <div className="rounded-xl border border-violet-500/30 bg-violet-500/[0.04] p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-violet-300 truncate">
          From profile · {profile.name}
        </div>
        <div className="text-[11px] text-neutral-500">
          {profile.job_count > 1
            ? `Used by ${profile.job_count} jobs — edits propagate live`
            : "Edits propagate to any job that uses this profile"}
        </div>
      </div>

      {profile.swaps.length === 0 ? (
        <div className="text-xs text-neutral-500 py-2">
          This profile has no swaps yet. Add some in the draft section above
          and click <strong>Push to profile</strong>, or edit it directly in
          Settings → Color profiles.
        </div>
      ) : (
        <ul className="space-y-2">
          {profile.swaps.map((s, idx) => {
            const isOpen = openIdx === idx;
            return (
              <li
                key={idx}
                className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-2 space-y-2"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => {
                      setOpenIdx(isOpen && openSide === "source" ? null : idx);
                      setOpenSide("source");
                    }}
                    className={`flex items-center gap-1.5 rounded-md border px-1.5 py-1 transition ${
                      isOpen && openSide === "source"
                        ? "border-violet-500"
                        : "border-neutral-700 hover:border-neutral-500"
                    }`}
                    title={`Source ${rgbToHex(s.source)}`}
                  >
                    <span
                      className="h-5 w-5 rounded border border-black/20"
                      style={{ backgroundColor: rgbCss(s.source) }}
                    />
                    <span className="text-[11px] font-mono text-neutral-300">
                      {rgbToHex(s.source)}
                    </span>
                  </button>

                  <span className="text-neutral-500 text-xs">→</span>

                  <button
                    type="button"
                    onClick={() => {
                      setOpenIdx(isOpen && openSide === "target" ? null : idx);
                      setOpenSide("target");
                    }}
                    className={`flex items-center gap-1.5 rounded-md border px-1.5 py-1 transition ${
                      isOpen && openSide === "target"
                        ? "border-violet-500"
                        : "border-neutral-700 hover:border-neutral-500"
                    }`}
                    title={`Target ${rgbToHex(s.target)}`}
                  >
                    <span
                      className="h-5 w-5 rounded border border-black/20"
                      style={{ backgroundColor: rgbCss(s.target) }}
                    />
                    <span className="text-[11px] font-mono text-neutral-300">
                      {rgbToHex(s.target)}
                    </span>
                  </button>

                  {s.label && (
                    <span className="text-xs text-neutral-500 truncate flex-1 min-w-0">
                      {s.label}
                    </span>
                  )}

                  <button
                    type="button"
                    onClick={() => onRemove(idx)}
                    className="ml-auto text-neutral-500 hover:text-rose-400 text-xs px-1.5"
                    title="Remove from profile (affects all linked jobs)"
                  >
                    ✕
                  </button>
                </div>

                {isOpen && (
                  <RgbColorPicker
                    value={openSide === "source" ? s.source : s.target}
                    onChange={(rgb) =>
                      onUpdate(
                        idx,
                        openSide === "source" ? { source: rgb } : { target: rgb }
                      )
                    }
                    source={openSide === "target" ? s.source : undefined}
                    label={
                      openSide === "source"
                        ? "Source colour (matched in artwork)"
                        : "Target colour (printed)"
                    }
                    detectedForSnap={
                      openSide === "source" ? detected : undefined
                    }
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Returns a debounced "PATCH this profile" function. Every call resets a
 * 500 ms timer; the last set of swaps wins. Keeps the typing experience
 * snappy without spamming the backend on every R/G/B keystroke.
 */
function useProfilePatchTimer(
  setActiveProfile: (p: ColorProfile | null) => void,
  setProfiles: React.Dispatch<React.SetStateAction<ColorProfile[]>>
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);

  // Cancel any pending PATCH on unmount so we don't fire after navigation.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return useCallback(
    (profileId: string, swaps: ColorSwap[]) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(async () => {
        try {
          await (inflightRef.current ?? Promise.resolve());
          inflightRef.current = updateColorProfile(profileId, { swaps }).then(
            (next) => {
              setActiveProfile(next);
              setProfiles((cur) =>
                cur.map((p) => (p.id === next.id ? next : p))
              );
            }
          ) as Promise<unknown> as Promise<void>;
          await inflightRef.current;
        } catch {
          // Surface errors elsewhere - this is a best-effort autosave;
          // the user still has the same data in local state.
        } finally {
          inflightRef.current = null;
        }
      }, 500);
    },
    [setActiveProfile, setProfiles]
  );
}

function SaveAsProfileModal({
  defaultName,
  onCancel,
  onSave,
}: {
  defaultName: string;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(defaultName);
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-6"
      onClick={onCancel}
    >
      <div
        className="w-full sm:max-w-md bg-neutral-950 border border-neutral-800 rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="text-lg font-semibold">Save as profile</h3>
          <p className="text-sm text-neutral-400 mt-1">
            Profiles are reusable across all your jobs. Edits to a profile
            propagate live to every job using it.
          </p>
        </div>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          maxLength={200}
          placeholder="ROLAND PRINTER"
          className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-base focus:border-violet-500 focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) onSave(name.trim());
            if (e.key === "Escape") onCancel();
          }}
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-neutral-700 px-4 py-2 text-sm hover:border-neutral-500"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(name.trim())}
            disabled={!name.trim()}
            className="rounded-lg bg-emerald-500 text-emerald-950 px-4 py-2 text-sm font-semibold hover:bg-emerald-400 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

