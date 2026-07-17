import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: {
          DEFAULT: "#0A0A0A",
          card: "#141414",
          elevated: "#1C1C1C",
          border: "#262626",
        },
        primary: {
          DEFAULT: "#F59E0B",
          hover: "#D97706",
        },
        status: {
          success: "#22C55E",
          warning: "#F59E0B",
          danger: "#EF4444",
          info: "#06B6D4",
          accent: "#8B5CF6",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      borderRadius: {
        card: "12px",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
