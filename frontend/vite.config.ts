import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), {
    name: 'startup-shell-first',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        // Vite hoists the entry into <head>. Keep the small startup shell ahead
        // of the code/styles that singlefile will inline into these tags.
        const assets: string[] = []
        const result = html.replace(/<head>[\s\S]*?<\/head>/, head => head.replace(
          /<script\b[^>]*\btype="module"[^>]*>[\s\S]*?<\/script>|<link\b[^>]*\brel="stylesheet"[^>]*>/g,
          tag => { assets.push(tag); return '' },
        ).replace(/^[\t ]+$/gm, ''))
        return result.replace('</body>', `${assets.join('\n')}\n</body>`)
      },
    },
  }, viteSingleFile()],
  build: {
    target: 'esnext',
  },
})
