import { useState, useRef, useEffect } from "react";
import { useTheme, type Theme } from "./ThemeProvider";
import { useColourScheme, COLOUR_SCHEMES } from "./ColourSchemeProvider";

const THEMES: { value: Theme; label: string; icon: string }[] = [
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "liquid", label: "Liquid", icon: "droplets" },
];

function SunIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </svg>
  );
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
    </svg>
  );
}

function DropletsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z" />
      <path d="M12.56 14.1c1.44 0 2.6-1.19 2.6-2.64 0-.76-.37-1.47-1.11-2.08S12.73 7.88 12.56 7.1c-.19.94-.74 1.84-1.49 2.44s-1.11 1.28-1.11 2.04c0 1.45 1.17 2.64 2.6 2.64z" />
      <path d="M17 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S15.29 6.75 15 5.3c-.29 1.45-1.14 2.84-2.29 3.76S11 11.1 11 12.25c0 2.22 1.8 4.05 4 4.05z" />
    </svg>
  );
}

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const { colourScheme, setColourScheme } = useColourScheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const iconClass = "w-4 h-4";
  const currentIcon = theme === "light" ? <SunIcon className={iconClass} /> : theme === "liquid" ? <DropletsIcon className={iconClass} /> : <MoonIcon className={iconClass} />;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center w-9 h-9 rounded-md border border-th-border text-th-muted hover:text-th-text hover:border-th-border-hover transition-colors"
        title="Theme"
      >
        {currentIcon}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-48 rounded-lg border shadow-xl z-50 p-1.5 space-y-0.5 theme-dropdown" style={{ backgroundColor: '#1e1e1e', borderColor: '#3a3a3a' }}>
          {THEMES.map((t) => (
            <button
              key={t.value}
              onClick={() => { setTheme(t.value); if (t.value !== "liquid") setOpen(false); }}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition ${
                theme === t.value ? "bg-white/10 text-white font-medium" : "text-neutral-300 hover:bg-white/5 hover:text-white"
              }`}
            >
              {t.icon === "sun" && <SunIcon className="w-4 h-4" />}
              {t.icon === "moon" && <MoonIcon className="w-4 h-4" />}
              {t.icon === "droplets" && <DropletsIcon className="w-4 h-4" />}
              {t.label}
              {theme === t.value && (
                <svg className="ml-auto w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </button>
          ))}

          {theme === "liquid" && (
            <>
              <div className="border-t border-white/10 my-1.5" />
              <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-neutral-400 font-semibold">Colour scheme</div>
              <div className="grid grid-cols-3 gap-1.5 px-1 pb-1">
                {COLOUR_SCHEMES.map((s) => (
                  <button
                    key={s.value}
                    onClick={() => setColourScheme(s.value)}
                    className={`flex flex-col items-center gap-1 rounded-md border px-1.5 py-1.5 transition ${
                      colourScheme === s.value ? "border-violet-500 ring-1 ring-violet-500" : "border-white/10 hover:border-white/20"
                    }`}
                  >
                    <span className="w-5 h-5 rounded-full ring-1 ring-black/20" style={{ background: s.preview }} />
                    <span className="text-[10px] text-neutral-400">{s.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
