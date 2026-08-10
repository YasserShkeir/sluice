// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Sluice webapp — a local-only SPA that talks to the runner over ws://127.0.0.1:7788/ws.
// @sluice/core is imported for TYPES only (`import type`), so those imports are erased at
// build time and Vite never has to resolve the workspace TS package at runtime.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Pinned so the URL the runner prints (http://localhost:5273/#k=<token>) is
    // always correct; strictPort makes vite fail loudly rather than drift ports.
    port: 5273,
    strictPort: true,
  },
});
