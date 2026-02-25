import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backendProxy = {
  '/chat': { target: 'https://nakom.is', changeOrigin: true },
  '/chat-stream': { target: 'https://nakom.is', changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  base: '/static/social-app/',
  server: { proxy: backendProxy },
  preview: { proxy: backendProxy },
})
