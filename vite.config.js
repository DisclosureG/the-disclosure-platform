import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import fs from 'fs'

// Serve public/artefacts/index.html for /artefacts/ in dev
// (Vite's SPA fallback would otherwise serve the React app instead)
const artefactsMiddleware = {
  name: 'serve-artefacts-index',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url === '/artefacts' || req.url === '/artefacts/') {
        const file = resolve(__dirname, 'public/artefacts/index.html')
        res.setHeader('Content-Type', 'text/html')
        res.end(fs.readFileSync(file))
      } else {
        next()
      }
    })
  }
}

export default defineConfig({
  plugins: [react(), artefactsMiddleware],
  base: '/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main:  resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin/index.html'),
      }
    }
  },
  publicDir: 'public'
})
