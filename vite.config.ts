import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { ocrAssets } from './scripts/viteOcrAssets.ts'
import { pdfAssets } from './scripts/vitePdfAssets.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), ocrAssets(), pdfAssets()],
})
