import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import fs from 'fs'
import { cp, rm } from 'fs/promises'

// The whole platform is served under /demo/. The site root (/) is a static
// landing page from landing/index.html, copied into dist/ after the Vite build.
const multiPageMiddleware = {
  name: 'serve-multi-page',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = req.url.split('?')[0]
      let file = null
      if (url === '/' || url === '') {
        file = resolve(__dirname, 'landing/index.html')
      } else if (url === '/demo' || url === '/demo/') {
        file = resolve(__dirname, 'src/index.html')
      } else if (url === '/demo/evidence' || url.startsWith('/demo/evidence/')) {
        file = resolve(__dirname, 'src/evidence/index.html')
      } else if (url === '/demo/peer-review' || url.startsWith('/demo/peer-review/')) {
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

// Vite builds the platform into dist/demo/ (base = '/demo/'). After the build
// we (1) lift the HTML files out of the dist/demo/src/* nested input tree, and
// (2) drop the static landing/index.html at dist/index.html.
const cleanupBuildOutput = {
  name: 'cleanup-build-output',
  apply: 'build',
  async closeBundle() {
    const distDir = resolve(__dirname, 'dist')
    const demoDir = resolve(distDir, 'demo')
    const srcDir = resolve(demoDir, 'src')
    try {
      await cp(resolve(srcDir, 'index.html'), resolve(demoDir, 'index.html'), { force: true })
      await cp(resolve(srcDir, 'evidence', 'index.html'), resolve(demoDir, 'evidence', 'index.html'), { force: true })
      await cp(resolve(srcDir, 'peer-review', 'index.html'), resolve(demoDir, 'peer-review', 'index.html'), { force: true })
      await rm(srcDir, { recursive: true, force: true })
      await cp(resolve(__dirname, 'landing/index.html'), resolve(distDir, 'index.html'), { force: true })
    } catch (e) {
      console.warn('Cleanup output warning:', e.message)
    }
  }
}

// emptyOutDir only clears dist/demo (the configured outDir), so stale files
// from previous root-base builds (dist/index.html, dist/assets/, dist/evidence/,
// dist/peer-review/, dist/artefacts/) would otherwise persist and ship. Wipe
// dist/ at build start so the new layout is the only thing left.
const cleanDistBeforeBuild = {
  name: 'clean-dist-before-build',
  apply: 'build',
  async buildStart() {
    await rm(resolve(__dirname, 'dist'), { recursive: true, force: true })
  }
}

export default defineConfig({
  plugins: [react(), multiPageMiddleware, cleanDistBeforeBuild, cleanupBuildOutput],
  base: '/demo/',
  build: {
    outDir: 'dist/demo',
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
