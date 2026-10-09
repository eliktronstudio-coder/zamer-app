import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      manifest: {
        name: "Замер — цифровой объект",
        short_name: "Замер",
        lang: "ru",
        start_url: "/",
        display: "standalone",
        theme_color: "#17665b",
        background_color: "#f5f7f7",
        icons: [
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
        ],
      },
      workbox: {
        navigateFallback: "index.html",
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest,ttf}"],
      },
    }),
  ],
  test: { include: ["tests/**/*.test.ts"], setupFiles: ["tests/setup.ts"] },
});
