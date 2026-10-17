import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMotionUITheme, useMotionUITransition } from '@/components/motion-ui/ui-theme';

/** Subsequence fuzzy match: every query character must appear in order in `target`. */
export function fuzzyMatch(query, target) {
  if (!query) return true;
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) qi++;
  }
  return qi === query.length;
}

/** Whether a command survives the trimmed lower-cased query. */
export function commandMatches(command, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const label = (command.label || '').toLowerCase();
  const hint = (command.hint || '').toLowerCase();
  if (label.includes(q) || hint.includes(q)) return true;
  return (
    fuzzyMatch(q, label) ||
    (command.keywords?.some((kw) => kw.toLowerCase().includes(q) || fuzzyMatch(q, kw.toLowerCase())) ?? false)
  );
}

function derivedGroupOrder(items) {
  const seen = [];
  for (const item of items) {
    const group = item.group ?? '';
    if (!seen.includes(group)) seen.push(group);
  }
  return seen;
}

export function filterCommandGroups(items, groupOrder, query) {
  const order = groupOrder ?? derivedGroupOrder(items);
  return order
    .map((group) => ({
      group,
      items: items.filter((cmd) => (cmd.group ?? '') === group && commandMatches(cmd, query)),
    }))
    .filter((view) => view.items.length > 0);
}

export function nextCommandIndex(currentIndex, resultCount, direction) {
  if (resultCount === 0) return 0;
  return direction === 'next'
    ? (currentIndex + 1) % resultCount
    : (currentIndex - 1 + resultCount) % resultCount;
}

export function useCommandK({ defaultOpen = false, open: openProp, onOpenChange } = {}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : uncontrolledOpen;

  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  const setOpen = useCallback(
    (next) => {
      if (!isControlled) setUncontrolledOpen(next);
      onOpenChangeRef.current?.(next);
    },
    [isControlled],
  );

  const openPalette = useCallback(() => setOpen(true), [setOpen]);
  const closePalette = useCallback(() => setOpen(false), [setOpen]);

  const openRef = useRef(open);
  openRef.current = open;
  const toggle = useCallback(() => setOpen(!openRef.current), [setOpen]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen(!openRef.current);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setOpen]);

  return { open, setOpen, openPalette, closePalette, toggle };
}

export function CommandPalette({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  items = [],
  groupOrder,
  maxListHeight = 360,
  inputPlaceholder = 'Digite um comando ou busque fonte, tag, ação…',
  inputAriaLabel = 'Buscar comandos',
  dialogLabel = 'Paleta de comandos',
  footerHints = [
    { keys: '↑↓', label: 'navegar' },
    { keys: '↵', label: 'executar' },
    { keys: 'esc', label: 'fechar' },
  ],
  renderEmpty = (q) => `Nenhum comando para “${q}”.`,
  onSelect,
  onCustomQuerySubmit,
  customActionLabel,
  customQueryGroup = 'Query',
}) {
  const { motionMode } = useMotionUITheme();
  const still = motionMode === 'off';
  const calm = motionMode === 'calm';
  const motionAllowed = motionMode === 'full';
  const { open, closePalette } = useCommandK({
    open: openProp,
    defaultOpen,
    onOpenChange,
  });

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const highlightLayoutId = `${baseId}-cmdk-highlight`;
  const optionId = useCallback((id) => `${baseId}-opt-${id}`, [baseId]);

  const dynamicItems = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed || !onCustomQuerySubmit) return items;
    // A ação de "filtrar por texto" mora no próprio grupo (`customQueryGroup`, posicionado por
    // `groupOrder` no FIM): comando exato (ex.: "Ferramentas") vence a ação genérica no Enter.
    const customCmd = {
      id: `__custom_query__:${trimmed}`,
      label: customActionLabel ? customActionLabel(trimmed) : `Filtrar acervo por “${trimmed}”`,
      hint: 'Enter',
      group: customQueryGroup,
      isCustomQuery: true,
      rawQuery: trimmed,
      keywords: [trimmed],
    };
    return [...items, customCmd];
  }, [items, query, onCustomQuerySubmit, customActionLabel, customQueryGroup]);

  const filteredGroups = useMemo(
    () => filterCommandGroups(dynamicItems, groupOrder, query),
    [dynamicItems, groupOrder, query],
  );
  const flatResults = useMemo(
    () => filteredGroups.flatMap((g) => g.items),
    [filteredGroups],
  );

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setActiveIndex(0), [query]);

  useEffect(() => {
    const active = listRef.current?.querySelector('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closePalette();
      }
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, closePalette]);

  const handleKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => nextCommandIndex(i, flatResults.length, 'next'));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => nextCommandIndex(i, flatResults.length, 'previous'));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = flatResults[activeIndex];
      if (item) {
        if (item.isCustomQuery) onCustomQuerySubmit?.(item.rawQuery);
        else onSelect?.(item);
        closePalette();
      } else if (query.trim() && onCustomQuerySubmit) {
        onCustomQuerySubmit(query.trim());
        closePalette();
      }
    }
  };

  const enterTransition = useMotionUITransition('gentle');
  const snapTransition = useMotionUITransition('snap');

  let runningIndex = 0;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="overlay overlay-cmdk"
          initial={still ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={still ? undefined : { opacity: 0 }}
          transition={{ ...enterTransition }}
          onClick={closePalette}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={dialogLabel}
            className="cmdk-dialog"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            initial={
              still
                ? false
                : {
                    opacity: 0,
                    y: calm ? 0 : 16,
                    scale: calm ? 1 : 0.98,
                  }
            }
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={
              still
                ? undefined
                : {
                    opacity: 0,
                    y: calm ? 0 : 10,
                    scale: calm ? 1 : 0.98,
                    transition: { ...snapTransition },
                  }
            }
            transition={{ ...enterTransition }}
          >
            <div className="cmdk-head">
              <span className="cmdk-search-icon" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
              </span>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={inputPlaceholder}
                aria-label={inputAriaLabel}
                role="combobox"
                aria-expanded="true"
                aria-controls={listboxId}
                aria-activedescendant={
                  flatResults[activeIndex] ? optionId(flatResults[activeIndex].id) : undefined
                }
                className="cmdk-input"
              />
              {query && (
                <button
                  type="button"
                  className="searchbar-x"
                  onClick={() => setQuery('')}
                  aria-label="Clear"
                >
                  ×
                </button>
              )}
              <button type="button" className="cmdk-kbd-btn" onClick={closePalette}>
                esc
              </button>
            </div>

            <div
              ref={listRef}
              id={listboxId}
              role="listbox"
              aria-label={dialogLabel}
              style={{ maxHeight: maxListHeight }}
              className="cmdk-list"
            >
              {filteredGroups.length > 0 ? (
                filteredGroups.map(({ group, items: groupItems }) => (
                  <div key={group} className="cmdk-group">
                    <div className="cmdk-group-title">{group}</div>
                    {groupItems.map((command) => {
                      const index = runningIndex++;
                      const isActive = index === activeIndex;
                      return (
                        <div
                          key={command.id}
                          id={optionId(command.id)}
                          role="option"
                          aria-selected={isActive}
                          data-active={isActive}
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => {
                            if (command.isCustomQuery) onCustomQuerySubmit?.(command.rawQuery);
                            else onSelect?.(command);
                            closePalette();
                          }}
                          className="cmdk-row"
                        >
                          {isActive && (
                            <motion.div
                              layoutId={motionAllowed ? highlightLayoutId : undefined}
                              transition={{ ...snapTransition }}
                              className="cmdk-highlight"
                              aria-hidden="true"
                            />
                          )}
                          <span className="cmdk-row-main">
                            {command.badge && (
                              <span className="cmdk-row-badge" data-active={command.active || undefined}>
                                {command.badge}
                              </span>
                            )}
                            <span className="cmdk-row-texts">
                              <span className="cmdk-row-label">{command.label}</span>
                              {command.hint && <span className="cmdk-row-hint">{command.hint}</span>}
                            </span>
                          </span>
                          <span className="cmdk-row-right">
                            {command.count != null && (
                              <span className="cmdk-row-count">{command.count}</span>
                            )}
                            {command.shortcut ? (
                              <kbd className="cmdk-kbd">{command.shortcut.join(' ')}</kbd>
                            ) : (
                              <span className="cmdk-return" aria-hidden="true">↵</span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))
              ) : (
                <p className="cmdk-empty">{renderEmpty(query.trim())}</p>
              )}
            </div>

            <div className="cmdk-foot">
              {footerHints.map((hint) => (
                <span key={hint.keys} className="cmdk-foot-hint">
                  <kbd className="cmdk-kbd">{hint.keys}</kbd>
                  <span>{hint.label}</span>
                </span>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
