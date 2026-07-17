import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#FF7A28",
          dark: "#E0631A",
          light: "#FFF1E6",
        },
      },
    },
  },
  plugins: [],
};

export default config;
