/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        risk: { low: "#2f9e6e", watch: "#d98e04", vet: "#d1453b" },
      },
    },
  },
  plugins: [],
};
