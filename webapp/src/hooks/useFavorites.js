import { useSyncExternalStore } from 'react';
import { getFavoritesSnapshot, subscribeFavorites } from '../lib/favorites.js';

/**
 * Set<id> dos favoritos do navegador, reativo: todos os consumidores re-renderizam juntos a
 * cada toggle (o store emite com snapshot de identidade estável — contrato do
 * useSyncExternalStore). As MUTAÇÕES são `toggleFavorite`/`removeFavorite`/`clearFavorites`
 * de lib/favorites.js (importadas direto onde só se escreve).
 */
export function useFavorites() {
  return useSyncExternalStore(subscribeFavorites, getFavoritesSnapshot, getFavoritesSnapshot);
}
