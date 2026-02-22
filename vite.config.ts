import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Strips `crossorigin` attributes from HTML output.
 * Electron loads via file:// protocol where crossorigin causes CORS failures.
 */
function stripCrossorigin(): Plugin {
  return {
    name: 'strip-crossorigin',
    transformIndexHtml(html) {
      return html.replace(/ crossorigin/g, '');
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), stripCrossorigin()],
  base: './',
  build: {
    modulePreload: false,
  },
})
