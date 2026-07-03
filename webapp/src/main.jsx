import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import '@fontsource-variable/bricolage-grotesque';
import './styles/tokens.css';
import './styles/globals.css';
import App from './App.jsx';

// reducedMotion="user": TODA animação do Motion (animate/exit/gestos) respeita a preferência
// do sistema automaticamente; efeitos contínuos usam useReducedMotion nos componentes.
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </React.StrictMode>,
);
