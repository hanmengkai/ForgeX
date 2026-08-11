import { useLayoutEffect, useState } from "react";

import { MoonIcon, SunIcon } from "./icons.js";

export type ColorTheme = "light" | "dark";

const themeStorageKey = "forgex-color-theme";

const readStoredTheme = (): ColorTheme => {
  if (typeof window === "undefined") return "light";
  try {
    return window.localStorage.getItem(themeStorageKey) === "dark"
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
};

const applyTheme = (theme: ColorTheme): void => {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
};

const saveTheme = (theme: ColorTheme): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(themeStorageKey, theme);
  } catch {
    // 浏览器禁用本地存储时仍保留当前页面的主题，不中断控制台。
  }
};

export const initializeColorTheme = (): ColorTheme => {
  const theme = readStoredTheme();
  applyTheme(theme);
  return theme;
};

export function ThemeToggle() {
  const [theme, setTheme] = useState<ColorTheme>(readStoredTheme);

  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const dark = theme === "dark";
  const targetTheme = dark ? "浅色" : "深色";

  return (
    <button
      className="theme-toggle"
      type="button"
      aria-label={`切换为${targetTheme}主题`}
      aria-pressed={dark}
      title={`切换为${targetTheme}主题`}
      onClick={() => {
        const nextTheme = dark ? "light" : "dark";
        applyTheme(nextTheme);
        saveTheme(nextTheme);
        setTheme(nextTheme);
      }}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
      <span>{targetTheme}</span>
    </button>
  );
}
