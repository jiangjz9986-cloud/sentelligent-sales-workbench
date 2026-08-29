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
        registerType: "prompt",
        workbox: {
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
