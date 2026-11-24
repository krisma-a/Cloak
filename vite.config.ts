import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { ocrAssets } from './scripts/viteOcrAssets.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), ocrAssets()],
})
