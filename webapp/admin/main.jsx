import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import '@fontsource-variable/bricolage-grotesque';
import '../src/styles/tokens.css';
import '../src/styles/globals.css';
import '../src/styles/app.css';
import './admin.css';
import AdminApp from './AdminApp.jsx';
import { LocaleProvider } from '../src/i18n.jsx';

// Mesma moldura do site (reducedMotion="user") — o admin herda tokens, tema e idioma.
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <LocaleProvider>
        <AdminApp />
      </LocaleProvider>
    </MotionConfig>
  </React.StrictMode>,
);
