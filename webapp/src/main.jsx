import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import '@fontsource-variable/bricolage-grotesque';
import './styles/tokens.css';
import './styles/globals.css';
import App from './App.jsx';
import { LocaleProvider } from './i18n.jsx';
import { MotionUIThemeProvider } from '@/components/motion-ui/ui-theme';
import motionTheme from '@/motion.theme';

// reducedMotion="user" + MotionUIThemeProvider: toda a coreografia consome os tokens do
// motion.theme.js (snap, ui, gentle, lively, ambient) e degrada com elegância ("calm").
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <MotionUIThemeProvider theme={motionTheme}>
        <LocaleProvider>
          <App />
        </LocaleProvider>
      </MotionUIThemeProvider>
    </MotionConfig>
  </React.StrictMode>,
);
