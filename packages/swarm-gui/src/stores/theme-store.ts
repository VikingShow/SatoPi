import { create } from "zustand";

type Theme = "dark" | "light" | "system";

interface ThemeState {
  theme: Theme;
  resolved: "dark" | "light";
  setTheme: (t: Theme) => void;
}

function resolveTheme(theme: Theme): "dark" | "light" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}

function applyTheme(theme: Theme) {
  const resolved = resolveTheme(theme);
  document.documentElement.setAttribute("data-theme", resolved);
  if (resolved === "dark") {
    document.documentElement.classList.add("dark");
    document.documentElement.style.colorScheme = "dark";
  } else {
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "light";
  }
}

const initialTheme = (localStorage.getItem("sato-theme") as Theme) || "dark";
applyTheme(initialTheme);

export const useThemeStore = create<ThemeState>((set) => ({
  theme: initialTheme,
  resolved: resolveTheme(initialTheme),
  setTheme: (theme) => {
    localStorage.setItem("sato-theme", theme);
    applyTheme(theme);
    set({ theme, resolved: resolveTheme(theme) });
  },
}));
