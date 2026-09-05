import { defineConfig } from 'vite';

// This machine is remote (192.168.1.100) and VS Code / the browser are local,
// so the dev and preview servers need to listen on all interfaces, not just
// localhost, to be reachable at http://192.168.1.100:<port>.
export default defineConfig({
  server: {
    host: true,
  },
  preview: {
    host: true,
  },
});
