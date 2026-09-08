/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        geo: {
          bg: "#0a0e14",
          panel: "rgba(11, 18, 32, 0.92)",
          accent: "#00d4ff",
          muted: "rgba(255,255,255,0.45)",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
