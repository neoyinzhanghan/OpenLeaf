import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ThemeScheme = "light" | "dark";

export type ThemeId =
  | "classic-dark"
  | "classic-light"
  | "vellum-nocturne"
  | "ivory-press"
  | "abyssal-ink"
  | "noir-atelier"
  | "moss-manuscript"
  | "porcelain-dawn"
  | "copper-ledger"
  | "saffron-midnight";

export type ThemeDefinition = {
  id: ThemeId;
  name: string;
  tagline: string;
  scheme: ThemeScheme;
  /** Swatch chips for the picker: canvas · accent · ink */
  swatches: [string, string, string];
  group: "classic" | "signature";
};

export const THEMES: ThemeDefinition[] = [
  {
    id: "classic-dark",
    name: "Classic Dark",
    tagline: "Teal ink on slate",
    scheme: "dark",
    swatches: ["#0b0e11", "#5ec4b6", "#eef2f6"],
    group: "classic",
  },
  {
    id: "classic-light",
    name: "Classic Light",
    tagline: "Studio daylight",
    scheme: "light",
    swatches: ["#f4f5f7", "#1a7a70", "#12171d"],
    group: "classic",
  },
  {
    id: "vellum-nocturne",
    name: "Vellum Nocturne",
    tagline: "Warm charcoal & amber resin",
    scheme: "dark",
    swatches: ["#1c1916", "#d4a574", "#f3ebe1"],
    group: "signature",
  },
  {
    id: "ivory-press",
    name: "Ivory Press",
    tagline: "Letterpress on soft paper",
    scheme: "light",
    swatches: ["#f6f0e6", "#9a6b2f", "#2a2118"],
    group: "signature",
  },
  {
    id: "abyssal-ink",
    name: "Abyssal Ink",
    tagline: "Deep ocean, seafoam edge",
    scheme: "dark",
    swatches: ["#07111f", "#5ec8d8", "#d7eef5"],
    group: "signature",
  },
  {
    id: "noir-atelier",
    name: "Noir Atelier",
    tagline: "Gallery black & champagne",
    scheme: "dark",
    swatches: ["#070707", "#d4af7a", "#f2ebe3"],
    group: "signature",
  },
  {
    id: "moss-manuscript",
    name: "Moss Manuscript",
    tagline: "Forest desk, sage marginalia",
    scheme: "dark",
    swatches: ["#101612", "#8fbc8f", "#e4efe4"],
    group: "signature",
  },
  {
    id: "porcelain-dawn",
    name: "Porcelain Dawn",
    tagline: "Cool mist & celadon",
    scheme: "light",
    swatches: ["#f2f5f7", "#3d7a78", "#1a2428"],
    group: "signature",
  },
  {
    id: "copper-ledger",
    name: "Copper Ledger",
    tagline: "Ledger brown, burnished metal",
    scheme: "dark",
    swatches: ["#16110e", "#c87941", "#f0e6dc"],
    group: "signature",
  },
  {
    id: "saffron-midnight",
    name: "Saffron Midnight",
    tagline: "Indigo night, saffron filament",
    scheme: "dark",
    swatches: ["#0c0e16", "#e8b84a", "#ece8f4"],
    group: "signature",
  },
];

const THEME_BY_ID = Object.fromEntries(THEMES.map((t) => [t.id, t])) as Record<
  ThemeId,
  ThemeDefinition
>;

const STORAGE_KEY = "openleaf.theme";

type ThemeContextValue = {
  theme: ThemeId;
  definition: ThemeDefinition;
  scheme: ThemeScheme;
  setTheme: (id: ThemeId) => void;
  /** @deprecated Prefer setTheme — kept for any leftover callers */
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isThemeId(value: string): value is ThemeId {
  return value in THEME_BY_ID;
}

function migrateStored(raw: string | null): ThemeId {
  if (!raw) return "classic-dark";
  if (raw === "dark") return "classic-dark";
  if (raw === "light") return "classic-light";
  if (isThemeId(raw)) return raw;
  return "classic-dark";
}

function readStoredTheme(): ThemeId {
  try {
    return migrateStored(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "classic-dark";
  }
}

function applyTheme(id: ThemeId): void {
  const def = THEME_BY_ID[id];
  document.documentElement.dataset.theme = id;
  document.documentElement.dataset.scheme = def.scheme;
  document.documentElement.style.colorScheme = def.scheme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(() => {
    const initial = readStoredTheme();
    applyTheme(initial);
    return initial;
  });

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const setTheme = useCallback((id: ThemeId) => {
    setThemeState(id);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((t) => (THEME_BY_ID[t].scheme === "dark" ? "classic-light" : "classic-dark"));
  }, []);

  const definition = THEME_BY_ID[theme];

  const value = useMemo(
    () => ({
      theme,
      definition,
      scheme: definition.scheme,
      setTheme,
      toggleTheme,
    }),
    [theme, definition, setTheme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

export function getThemeDefinition(id: ThemeId): ThemeDefinition {
  return THEME_BY_ID[id];
}
