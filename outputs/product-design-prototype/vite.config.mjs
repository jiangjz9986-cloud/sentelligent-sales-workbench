import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { normalizeBasePath } from "./src/app/routes.js";

export function resolvePublicBasePath(value) {
  return normalizeBasePath(value);
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const configuredBasePath =
    process.env.VITE_PUBLIC_BASE_PATH ?? env.VITE_PUBLIC_BASE_PATH;

  return {
    base: resolvePublicBasePath(configuredBasePath),
    resolve: {
      preserveSymlinks: true,
    },
    optimizeDeps: {
      include: ["react", "react-dom/client"],
    },
    server: {
      warmup: {
        clientFiles: ["./src/main.jsx"],
      },
    },
    plugins: [
      react(),
      VitePWA({
        strategies: "generateSW",
        injectRegister: null,
        registerType: "autoUpdate",
        manifest: {
          name: "森特智行销售工作台",
          short_name: "森特智行",
          description: "森特智行 AI 销售作战台：快速记录、客户画像、商机档案、周报与差旅报销一体化工作台。",
          start_url: "./overview",
          scope: "./",
          display: "standalone",
          background_color: "#f3f5fa",
          theme_color: "#f3f5fa",
          lang: "zh-CN",
          id: "sentelligent-sales-workbench",
          icons: [
            { src: "pwa-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "pwa-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
            { src: "pwa-icon-192-maskable.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
            { src: "pwa-icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          ],
        },
        workbox: {
          skipWaiting: true,
          clientsClaim: true,
          globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest}"],
          navigateFallback: "index.html",
          navigateFallbackDenylist: [/^\/api/],
          runtimeCaching: [
            {
              urlPattern: ({ request, url }) => (
                !url.pathname.startsWith("/api/")
                && ["script", "style", "font", "image"].includes(request.destination)
              ),
              handler: "StaleWhileRevalidate",
              options: {
                cacheName: "sentelligent-assets",
              },
            },
            {
              urlPattern: ({ request, url }) => request.mode === "navigate" && !url.pathname.startsWith("/api/"),
              handler: "NetworkFirst",
              options: {
                cacheName: "sentelligent-pages",
                networkTimeoutSeconds: 3,
              },
            },
          ],
        },
      }),
    ],
  };
});
