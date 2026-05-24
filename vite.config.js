import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import fs from 'fs'
import { cp, rm } from 'fs/promises'

const multiPageMiddleware = {
  name: 'serve-multi-page',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = req.url.split('?')[0]
      if (url === '/' || url === '') {
        const file = resolve(__dirname, 'src/index.html')
        const html = fs.readFileSync(file, 'utf-8')
        const transformed = await server.transformIndexHtml(url, html)
        res.setHeader('Content-Type', 'text/html')
        res.end(transformed)
      } else if (url.startsWith('/evidence')) {
        const file = resolve(__dirname, 'src/evidence/index.html')
        const html = fs.readFileSync(file, 'utf-8')
        const transformed = await server.transformIndexHtml(url, html)
        res.setHeader('Content-Type', 'text/html')
        res.end(transformed)
      } else if (url.startsWith('/peer-review')) {
        const file = resolve(__dirname, 'src/peer-review/index.html')
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

const cleanupBuildOutput = {
  name: 'cleanup-build-output',
  apply: 'build',
  async closeBundle() {
    const distDir = resolve(__dirname, 'dist')
    const srcDir = resolve(distDir, 'src')
    try {
      // Move files from dist/src/* to dist/* and remove dist/src
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
