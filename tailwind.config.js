/** @type {import('tailwindcss').Config} */

/**
 * Colour is driven by CSS custom properties defined in src/styles/tokens.css,
 * so light and dark themes share one set of Tailwind utilities and only the
 * variable values swap. Do not add raw hex colours to components.
 */
const semanticColors = {
  app: "var(--bg-app)",
  panel: "var(--bg-panel)",
  "panel-2": "var(--bg-panel-2)",
  surface: "var(--bg-surface)",
  elevated: "var(--bg-elevated)",
  line: "var(--border-subtle)",
  "line-strong": "var(--border-strong)",
  ink: "var(--text-primary)",
  "ink-2": "var(--text-secondary)",
  "ink-3": "var(--text-muted)",
  hover: "var(--hover-overlay)",
  active: "var(--active-overlay)",
  chip: "var(--chip-bg)",
  accent: "var(--accent)",
  "accent-hover": "var(--accent-hover)",
  "accent-ink": "var(--accent-ink)",
  "accent-soft": "var(--accent-soft)",
  positive: "var(--positive)",
  "positive-soft": "var(--positive-soft)",
  warning: "var(--warning)",
  "warning-soft": "var(--warning-soft)",
  danger: "var(--danger)",
  "danger-soft": "var(--danger-soft)",
  focus: "var(--focus-ring)",
};

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: semanticColors,
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "'Segoe UI'",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "'JetBrains Mono'",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
        xs: ["0.75rem", { lineHeight: "1.1rem" }],
        sm: ["0.8125rem", { lineHeight: "1.25rem" }],
        base: ["0.875rem", { lineHeight: "1.45rem" }],
        md: ["0.9375rem", { lineHeight: "1.55rem" }],
        lg: ["1.0625rem", { lineHeight: "1.65rem" }],
        xl: ["1.25rem", { lineHeight: "1.75rem" }],
        "2xl": ["1.5rem", { lineHeight: "2rem" }],
      },
      borderRadius: {
        sm: "0.375rem",
        DEFAULT: "0.5rem",
        md: "0.5rem",
        lg: "0.625rem",
        xl: "0.75rem",
        "2xl": "1rem",
      },
      boxShadow: {
        subtle: "0 1px 2px 0 rgba(0, 0, 0, 0.04)",
        card: "0 1px 3px 0 rgba(0, 0, 0, 0.06), 0 1px 2px -1px rgba(0, 0, 0, 0.04)",
        pop:
          "0 12px 32px -8px rgba(0, 0, 0, 0.18), 0 4px 12px -4px rgba(0, 0, 0, 0.10)",
        focus: "0 0 0 2px var(--focus-ring)",
      },
      transitionTimingFunction: {
        swift: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [],
};
