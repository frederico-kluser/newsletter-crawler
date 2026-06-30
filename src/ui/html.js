// JSX-like SEM build step: htm via tagged templates ligado ao createElement do React.
// Uso: html`<${Box}><${Text}>oi</${Text}></${Box}>`.
import htm from 'htm';
import { createElement } from 'react';

export const html = htm.bind(createElement);
