import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
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
    optimizeDeps: {
      include: ["react", "react-dom/client"],
    },
    server: {
      warmup: {
        clientFiles: ["./src/main.jsx"],
      },
    },
    plugins: [react()],
  };
});
