import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// GitHub Pages では /<repo>/ 配下に配信されるため相対パスでビルドする
export default defineConfig({
  plugins: [react()],
  base: './',
})
