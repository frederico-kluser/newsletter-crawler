// Tokens semânticos da TUI — cor/glifo/espaçamento SEMPRE via estes mapas (nunca literal inline
// nos widgets). Cor é canal REDUNDANTE: o estado também viaja nos glifos (NO_COLOR continua legível).
// Sem import de React: o módulo é puro e importável em teste sem Ink.
import { extendTheme, defaultTheme } from '@inkjs/ui';

export const colors = {
  accent: 'cyan', // valores, foco/seleção, spinner, barras de progresso
  title: 'magenta', // títulos de tela/seção e réguas
  ok: 'green',
  warn: 'yellow',
  err: 'red',
  link: 'blue',
  muted: 'gray', // meta que precisa de COR (o meta comum continua via dimColor)
};

export const glyphs = {
  pointer: '❯',
  app: '◆',
  tick: '✓', // fase concluída
  saved: '✔', // ticker de "salvos" (distinto do tick de fase — não fundir)
  cross: '✗',
  idle: '·',
  warn: '⚠',
  clock: '⏱',
  play: '▶',
  stop: '■',
  rule: '─',
};

export const space = { pad: 1, section: 1, panelPadX: 1 };

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Recolore os widgets do @inkjs/ui p/ os tokens (foco azul default → accent; barra magenta →
// accent). extendTheme faz deepmerge: as demais chaves default (container/option/…) sobrevivem.
// Badge/Alert/StatusMessage/TextInput ficam no default de propósito (Badge é assertado em teste).
export const uiTheme = extendTheme(defaultTheme, {
  components: {
    Select: {
      styles: {
        focusIndicator: () => ({ color: colors.accent }),
        label: ({ isFocused, isSelected }) => ({
          color: isFocused ? colors.accent : isSelected ? colors.ok : undefined,
        }),
      },
    },
    MultiSelect: {
      styles: {
        focusIndicator: () => ({ color: colors.accent }),
        selectedIndicator: () => ({ color: colors.ok }),
        label: ({ isFocused, isSelected }) => ({
          color: isFocused ? colors.accent : isSelected ? colors.ok : undefined,
        }),
      },
    },
    Spinner: { styles: { frame: () => ({ color: colors.accent }) } },
    ProgressBar: { styles: { completed: () => ({ color: colors.accent }) } },
  },
});
