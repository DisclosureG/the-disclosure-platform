import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import fs from 'fs'

const multiPageMiddleware = {
  name: 'serve-multi-page',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = req.url.split('?')[0]
      if (url === '/artefacts' || url === '/artefacts/') {
        const file = resolve(__dirname, 'public/artefacts/index.html')
        res.setHeader('Content-Type', 'text/html')
        res.end(fs.readFileSync(file))
      } else if (url.startsWith('/peer-review')) {
        const file = resolve(__dirname, 'peer-review/index.html')
        const html = fs.readFileSync(file, 'utf-8')
        const transformed = await server.transformIndexHtml(url, html)
        res.setHeader('Content-Type', 'text/html')
        res.end(transformed)
      } else {
        next()
      }
    })
  }
}


export default defineConfig({
  plugins: [react(), multiPageMiddleware],
  base: '/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main:        resolve(__dirname, 'index.html'),
        admin:       resolve(__dirname, 'admin/index.html'),
        evidence:    resolve(__dirname, 'evidence/index.html'),
        peerReview:  resolve(__dirname, 'peer-review/index.html'),
      },
      output: {
        // Force the ethers v6 runtime into its own chunk so it can be
        // downloaded lazily (via wallet-impl.js dynamic import) and cached
        // independently of the rest of the app. Without this, Rollup's
        // default chunking hoists ethers code into whichever chunk first
        // pulls it in, undoing the wallet.js code-split.
        manualChunks(id) {
          if (id.includes('node_modules/ethers'))                    return 'ethers';
          if (id.includes('node_modules/@adraffy'))                  return 'ethers'; // ENS namehash dep
          if (id.includes('node_modules/@noble/hashes'))             return 'ethers';
          if (id.includes('node_modules/@noble/curves'))             return 'ethers';
          if (id.includes('node_modules/@supabase'))                 return 'supabase';
          return undefined;
        },
      },
    }
  },
  publicDir: 'public'
})
