import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { PWA_OPTIONS } from './vite/pwa-options.js'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), VitePWA(PWA_OPTIONS)],
  test: {
    // Dummy Supabase creds so modules that construct the client at import time
    // (lib/supabase.js) don't throw when pulled into a unit test. Tests inject
    // their own fake client and never make real network calls.
    env: {
      VITE_SUPABASE_URL: 'http://localhost',
      VITE_SUPABASE_ANON_KEY: 'test-anon-key',
    },
  },
})
