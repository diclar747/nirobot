import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/global.css';
// Estilos compartidos entre páginas: con las rutas en lazy-load, si solo los importa una página, las demás quedan sin estilo
// hasta visitarla (ej. el encabezado de Campañas o los asistentes de Llamadas/SMS que usan clases campaign-*).
import './styles/page-kit.css';
import './styles/list-filters.css';
import './styles/campaigns.css';
import './styles/mobile-pwa.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
