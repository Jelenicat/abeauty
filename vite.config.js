// vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',     // SW se sam update-uje
      injectRegister: 'auto',         // automatski ubacuje registraciju SW-a
      manifest: {
        name: 'aBeauty',
        short_name: 'aBeauty',
        description: 'Frizersko-kozmetički salon',
        start_url: '/',               // odavde kreće app
        scope: '/',                   // opseg
        display: 'standalone',        // bez browser UI-a
        theme_color: '#ff7fb5',
        background_color: '#ffffff',
        icons: [
          { src: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,jpg,jpeg}']
      }
    })
  ]
})
