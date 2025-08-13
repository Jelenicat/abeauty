// vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
  VitePWA({
  registerType: 'autoUpdate',
  manifest: {
    name: 'aBeauty',
    short_name: 'aBeauty',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ff5f87', // tvoja roza (ako želiš)
    icons: [
      { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
      { src: '/maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  },
  // (po želji) runtime caching za slike:
  workbox: {
    globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
    runtimeCaching: [
      {
        urlPattern: ({ request }) => request.destination === 'image',
        handler: 'CacheFirst',
        options: {
          cacheName: 'images',
          expiration: { maxEntries: 60, maxAgeSeconds: 30 * 24 * 60 * 60 }
        }
      }
    ]
  }
})

  ]
})
