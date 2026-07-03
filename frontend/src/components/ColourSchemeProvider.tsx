import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useTheme } from "./ThemeProvider";

export type ColourScheme = "emerald" | "blue" | "purple" | "rose" | "amber" | "slate";

export const COLOUR_SCHEMES: { value: ColourScheme; label: string; preview: string }[] = [
  { value: "emerald", label: "Emerald", preview: "hsl(160,30%,18%)" },
  { value: "blue", label: "Ocean", preview: "hsl(220,35%,20%)" },
  { value: "purple", label: "Violet", preview: "hsl(270,30%,20%)" },
  { value: "rose", label: "Rose", preview: "hsl(340,30%,18%)" },
  { value: "amber", label: "Amber", preview: "hsl(35,35%,18%)" },
  { value: "slate", label: "Slate", preview: "hsl(220,10%,18%)" },
];

const STORAGE_KEY = "printlay-colour-scheme";
const VALID = new Set<string>(COLOUR_SCHEMES.map((s) => s.value));

interface ColourSchemeContextValue {
  colourScheme: ColourScheme;
  setColourScheme: (s: ColourScheme) => void;
}

const ColourSchemeContext = createContext<ColourSchemeContextValue>({
  colourScheme: "blue",
  setColourScheme: () => {},
});

export function ColourSchemeProvider({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const [scheme, setSchemeState] = useState<ColourScheme>(() => {
    if (typeof window === "undefined") return "blue";
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored && VALID.has(stored) ? (stored as ColourScheme) : "blue";
  });

  useEffect(() => {
    const root = document.documentElement;
    COLOUR_SCHEMES.forEach((cs) => root.classList.remove(`scheme-${cs.value}`));
    if (theme === "liquid") {
      root.classList.add(`scheme-${scheme}`);
    }
  }, [scheme, theme]);

  const setColourScheme = (s: ColourScheme) => {
    if (VALID.has(s)) {
      setSchemeState(s);
      localStorage.setItem(STORAGE_KEY, s);
    }
  };

  return (
    <ColourSchemeContext.Provider value={{ colourScheme: scheme, setColourScheme }}>
      {children}
    </ColourSchemeContext.Provider>
  );
}

export function useColourScheme() {
  return useContext(ColourSchemeContext);
}
