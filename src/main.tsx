/**
 * Tala Renderer Entry Point
 * 
 * Bootstraps the React application by mounting the `App` component
 * into the `#root` element of the `index.html`.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
