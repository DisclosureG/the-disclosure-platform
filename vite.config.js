import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import fs from 'fs'
import { cp, rm } from 'fs/promises'

// The platform is served from the site root (/). The home page is the SPA's
// main entry (src/index.html); the Evidence and Peer Review sub-apps live at
// /evidence/ and /peer-review/. This dev middleware maps those clean URLs to
// their HTML entry points so deep links resolve before Vite's static handler.
const multiPageMiddleware = {
  name: 'serve-multi-page',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = req.url.split('?')[0]
      let file = null
      if (url === '/' || url === '') {
        file = resolve(__dirname, 'src/index.html')
      } else if (url === '/evidence' || url.startsWith('/evidence/')) {
        file = resolve(__dirname, 'src/evidence/index.html')
      } else if (url === '/peer-review' || url.startsWith('/peer-review/')) {
        file = resolve(__dirname, 'src/peer-review/index.html')
      }
      if (file) {
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

// Vite emits the HTML entries into the nested input tree (dist/src/*). Lift them
// out to the locations the site serves from: the home page at dist/index.html,
// and the sub-apps at dist/evidence/ and dist/peer-review/.
const cleanupBuildOutput = {
  name: 'cleanup-build-output',
  apply: 'build',
  async closeBundle() {
    const distDir = resolve(__dirname, 'dist')
    const srcDir = resolve(distDir, 'src')
    try {
      await cp(resolve(srcDir, 'index.html'), resolve(distDir, 'index.html'), { force: true })
      await cp(resolve(srcDir, 'evidence', 'index.html'), resolve(distDir, 'evidence', 'index.html'), { force: true })
      await cp(resolve(srcDir, 'peer-review', 'index.html'), resolve(distDir, 'peer-review', 'index.html'), { force: true })
      await rm(srcDir, { recursive: true, force: true })
    } catch (e) {
      console.warn('Cleanup output warning:', e.message)
    }
  }
}

export default defineConfig({
  plugins: [react(), multiPageMiddleware, cleanupBuildOutput],
  base: '/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main:        resolve(__dirname, 'src/index.html'),
        evidence:    resolve(__dirname, 'src/evidence/index.html'),
        peerReview:  resolve(__dirname, 'src/peer-review/index.html'),
      },
      output: {
        // Entry JS chunks are hashed assets. HTML output location is handled by
        // Vite from the input paths and then relocated by the cleanupBuildOutput
        // plugin above — do NOT map entry chunk names to .html paths here, or the
        // injected <script src> ends up pointing at the HTML file itself and the
        // page loads it as a module (MIME error) → blank #root.
        entryFileNames: 'assets/[name]-[hash].js',
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
