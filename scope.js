/**
 * Smart Memory - SillyTavern Extension
 * Copyright (C) 2026 Senjin the Dragon
 * https://github.com/senjinthedragon/Smart-Memory
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Memory scope: where the per-character store lives.
 *
 * Every tier that upstream calls "persistent" - long-term memories, relationship
 * history, canon, pinned arcs, the persistent entity registry, and epistemic
 * knowledge - is read and written through one per-character container. This
 * module decides where that container is:
 *
 *   character scope (default, upstream behaviour)
 *     extension_settings[MODULE_NAME].characters[name]
 *     Memories follow the character into every chat.
 *
 *   chat scope
 *     chatMetadata[META_KEY].characterStores[name]
 *     A new chat starts with nothing. Branches and checkpoints inherit the
 *     store because SillyTavern copies the parent's chat metadata into every
 *     branch it creates, then the two diverge. Nothing crosses from one chat
 *     to another unless the user carries it over explicitly.
 *
 * Switching scope moves nothing and deletes nothing; it only changes which
 * container the helpers look at. The carry-over and promote functions below
 * are the explicit bridges between the two.
 *
 * getMemoryScope / isChatScoped  - current scope
 * getCharacterStore              - the container for one character (optionally created)
 * setCharacterStore              - replace the container for one character
 * deleteCharacterStore           - remove the container for one character
 * persistCharacterStores         - save whichever backing store is active
 * getGroupArcs / setGroupArcs    - group-level pinned arcs, same scoping rule
 * carryOverFromCharacter         - copy the character-level store into this chat
 * promoteToCharacter             - copy this chat's store to the character level
 */

import { saveSettingsDebounced } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { MODULE_NAME, META_KEY } from './constants.js';

/** Valid memory scopes. */
export const memory_scopes = {
  character: 'character',
  chat: 'chat',
};

/**
 * Returns the configured memory scope, defaulting to character scope.
 * @returns {'character'|'chat'}
 */
export function getMemoryScope() {
  const scope = extension_settings[MODULE_NAME]?.memory_scope;
  return scope === memory_scopes.chat ? memory_scopes.chat : memory_scopes.character;
}

/** @returns {boolean} True when per-character stores live in chat metadata. */
export function isChatScoped() {
  return getMemoryScope() === memory_scopes.chat;
}

/**
 * Returns the map of per-character stores for the given scope.
 * @param {'character'|'chat'} scope
 * @param {boolean} create - Create the container chain if missing.
 * @returns {Object|null}
 */
function getStoresForScope(scope, create) {
  if (scope === memory_scopes.chat) {
    const context = getContext();
    if (!context.chatMetadata) {
      if (!create) return null;
      context.chatMetadata = {};
    }
    const meta = context.chatMetadata;
    if (!meta[META_KEY]) {
      if (!create) return null;
      meta[META_KEY] = {};
    }
    if (!meta[META_KEY].characterStores) {
      if (!create) return null;
      meta[META_KEY].characterStores = {};
    }
    return meta[META_KEY].characterStores;
  }

  const settings = extension_settings[MODULE_NAME];
  if (!settings) return null;
  if (!settings.characters) {
    if (!create) return null;
    settings.characters = {};
  }
  return settings.characters;
}

/**
 * Returns the store for one character in the active scope.
 * @param {string} characterName
 * @param {{create?: boolean}} [options] - Create an empty store if none exists.
 * @returns {Object|null}
 */
export function getCharacterStore(characterName, { create = false } = {}) {
  if (!characterName) return null;
  const stores = getStoresForScope(getMemoryScope(), create);
  if (!stores) return null;
  if (!stores[characterName] && create) stores[characterName] = {};
  return stores[characterName] ?? null;
}

/**
 * Replaces the store for one character in the active scope.
 * @param {string} characterName
 * @param {Object} data
 */
export function setCharacterStore(characterName, data) {
  if (!characterName || !data || typeof data !== 'object') return;
  const stores = getStoresForScope(getMemoryScope(), true);
  stores[characterName] = data;
}

/**
 * Removes the store for one character from the active scope.
 * @param {string} characterName
 * @returns {boolean} True if a store existed and was removed.
 */
export function deleteCharacterStore(characterName) {
  if (!characterName) return false;
  const stores = getStoresForScope(getMemoryScope(), false);
  if (!stores?.[characterName]) return false;
  delete stores[characterName];
  return true;
}

/**
 * Persists whichever backing store the active scope uses. Safe to call after
 * every write; both paths are debounced.
 */
export function persistCharacterStores() {
  if (isChatScoped()) {
    const context = getContext();
    if (typeof context.saveMetadataDebounced === 'function') {
      context.saveMetadataDebounced();
    } else {
      context.saveMetadata?.();
    }
    return;
  }
  saveSettingsDebounced();
}

// ---- Group pinned arcs ----------------------------------------------------

/**
 * Returns the pinned arcs for a group in the active scope.
 * @param {string} groupId
 * @returns {Array}
 */
export function getGroupArcs(groupId) {
  if (!groupId) return [];
  if (isChatScoped()) {
    return getContext().chatMetadata?.[META_KEY]?.groupArcs?.[groupId] ?? [];
  }
  return extension_settings[MODULE_NAME]?.group_arcs?.[groupId] ?? [];
}

/**
 * Overwrites the pinned arcs for a group in the active scope and persists.
 * @param {string} groupId
 * @param {Array} arcs
 */
export function setGroupArcs(groupId, arcs) {
  if (!groupId) return;
  if (isChatScoped()) {
    const context = getContext();
    if (!context.chatMetadata) context.chatMetadata = {};
    if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
    if (!context.chatMetadata[META_KEY].groupArcs) context.chatMetadata[META_KEY].groupArcs = {};
    context.chatMetadata[META_KEY].groupArcs[groupId] = arcs;
  } else {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
    if (!extension_settings[MODULE_NAME].group_arcs)
      extension_settings[MODULE_NAME].group_arcs = {};
    extension_settings[MODULE_NAME].group_arcs[groupId] = arcs;
  }
  persistCharacterStores();
}

// ---- Explicit bridges between scopes ----------------------------------------

/**
 * Counts the entries a store holds, for reporting what a copy moved.
 * @param {Object|null} store
 * @returns {number}
 */
export function countStoreEntries(store) {
  if (!store) return 0;
  return (
    (store.memories?.length ?? 0) +
    Object.keys(store.relationship_history ?? {}).length +
    (store.canon ? 1 : 0) +
    (store.persistent_arcs?.length ?? 0) +
    (store.entities?.length ?? 0) +
    (store.epistemic_knowledge?.length ?? 0)
  );
}

/**
 * Copies the character-level store for a character into the current chat's
 * store, replacing whatever the chat had. This is the "I asked for it" path
 * in chat scope: memories from earlier chats arrive only when requested.
 *
 * @param {string} characterName
 * @returns {number} Entries copied, or -1 if there was nothing to copy.
 */
export function carryOverFromCharacter(characterName) {
  if (!characterName) return -1;
  const source = extension_settings[MODULE_NAME]?.characters?.[characterName];
  if (!source) return -1;
  const stores = getStoresForScope(memory_scopes.chat, true);
  stores[characterName] = structuredClone(source);
  const context = getContext();
  if (typeof context.saveMetadataDebounced === 'function') context.saveMetadataDebounced();
  else context.saveMetadata?.();
  return countStoreEntries(source);
}

/**
 * Copies the current chat's store for a character up to the character level,
 * replacing what was there. Use it when a chat's memories deserve to follow
 * the character into future chats.
 *
 * @param {string} characterName
 * @returns {number} Entries copied, or -1 if there was nothing to copy.
 */
export function promoteToCharacter(characterName) {
  if (!characterName) return -1;
  const source = getStoresForScope(memory_scopes.chat, false)?.[characterName];
  if (!source) return -1;
  const stores = getStoresForScope(memory_scopes.character, true);
  stores[characterName] = structuredClone(source);
  saveSettingsDebounced();
  return countStoreEntries(source);
}
