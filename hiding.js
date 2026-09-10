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
 * Compaction-coupled message hiding.
 *
 * Smart Memory never removed anything from the prompt: the raw history stayed
 * until SillyTavern's context limit dropped the oldest messages, and the
 * short-term summary covered whatever fell off. That works for a small local
 * context. On a hosted model with a large window nothing ever falls off, so
 * every turn re-sends stale prose that the summary already stands in for.
 *
 * This module hides messages once they are covered by the summary AND have
 * already been read by extraction, keeping a verbatim tail visible. It is
 * coupled to compaction, not extraction, because the summary is the thing
 * that replaces the messages in context; the memory tiers only supplement it.
 *
 * Hides are flagged as Smart Memory's own so a message the user hid by hand is
 * never restored by us, and Restore only touches what we hid. Hidden state is
 * per message, so branches and checkpoints inherit it with everything else.
 *
 * hideBoundary             - exclusive index below which hiding is safe
 * applyCompactionHiding    - hide below the boundary, restore ours above it
 * restoreCompactionHidden  - un-hide everything Smart Memory hid
 * isSmartMemoryHidden      - true if a message carries our hide flag
 */

import { hideChatMessageRange } from '../../../../scripts/chats.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { MODULE_NAME, META_KEY } from './constants.js';
import { smLog } from './logging.js';

/** Flag set in message.extra on every message Smart Memory hid. */
export const HIDE_FLAG = 'sm_hidden';

/**
 * @param {object} message
 * @returns {boolean} True if Smart Memory hid this message.
 */
export function isSmartMemoryHidden(message) {
  return !!message?.extra?.[HIDE_FLAG];
}

/**
 * Exclusive chat index below which messages may be hidden.
 *
 * Three limits apply, and the lowest wins:
 *   - the compaction boundary, so a hidden message is always covered by the summary;
 *   - the extraction cutoff, so a message cannot vanish before long-term and
 *     session extraction have read it, even if extraction has fallen behind;
 *   - the verbatim tail, compaction_keep_recent messages from the end of chat.
 *
 * Returns 0 (hide nothing) when the feature or compaction is off or there is
 * no summary yet.
 *
 * @returns {number}
 */
export function hideBoundary() {
  const settings = extension_settings[MODULE_NAME] ?? {};
  if (!settings.compaction_enabled || !settings.compaction_hide_enabled) return 0;

  const context = getContext();
  const meta = context.chatMetadata?.[META_KEY];
  const chat = context.chat ?? [];
  if (!meta?.summary) return 0;

  const summaryEnd = Math.min(meta.summaryEnd ?? 0, chat.length);

  // With extraction tiers on, nothing is hidden until the first pass has run.
  const extractionOn = settings.longterm_enabled || settings.session_enabled;
  const cutoff = meta.lastExtractCutoff;
  if (extractionOn && (cutoff === null || cutoff === undefined)) return 0;
  const extractionLimit = extractionOn ? Math.min(cutoff, chat.length) : chat.length;

  const keep = Math.max(0, Number(settings.compaction_keep_recent) || 0);
  const tailLimit = chat.length - keep;

  return Math.max(0, Math.min(summaryEnd, extractionLimit, tailLimit));
}

/**
 * Groups sorted indices into contiguous [start, end] ranges.
 * @param {number[]} indices
 * @returns {Array<[number, number]>}
 */
function toRanges(indices) {
  const ranges = [];
  for (const i of indices) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === i - 1) last[1] = i;
    else ranges.push([i, i]);
  }
  return ranges;
}

/**
 * Brings hidden state in line with the current boundary: hides visible
 * messages below it, restores messages we hid that are now above it (the
 * boundary moves back when messages are deleted or the feature is turned
 * off). Idempotent and cheap when nothing changes, so it is safe on chat load.
 *
 * @returns {Promise<{hidden: number, restored: number}>}
 */
export async function applyCompactionHiding() {
  const context = getContext();
  const chat = context.chat ?? [];
  const boundary = hideBoundary();

  const toHide = [];
  const toRestore = [];
  for (let i = 0; i < chat.length; i++) {
    const m = chat[i];
    if (!m) continue;
    if (i < boundary) {
      // Only claim messages that are visible now; a message the user hid stays theirs.
      if (!m.is_system) toHide.push(i);
    } else if (isSmartMemoryHidden(m)) {
      toRestore.push(i);
    }
  }

  for (const i of toHide) {
    if (typeof chat[i].extra !== 'object' || chat[i].extra === null) chat[i].extra = {};
    chat[i].extra[HIDE_FLAG] = true;
  }
  for (const i of toRestore) {
    delete chat[i].extra[HIDE_FLAG];
  }

  // hideChatMessageRange updates the DOM, swipe buttons, and saves the chat.
  for (const [start, end] of toRanges(toHide)) {
    await hideChatMessageRange(start, end, false);
  }
  for (const [start, end] of toRanges(toRestore)) {
    await hideChatMessageRange(start, end, true);
  }

  if (toHide.length || toRestore.length) {
    smLog(
      `[SmartMemory] Hiding: boundary ${boundary}, hid ${toHide.length}, restored ${toRestore.length}.`,
    );
  }
  return { hidden: toHide.length, restored: toRestore.length };
}

/**
 * Restores every message Smart Memory hid, leaving user hides alone.
 * Used by the Restore button and before the summary is wiped, so no message
 * is left hidden without a summary standing in for it.
 *
 * @returns {Promise<number>} Messages restored.
 */
export async function restoreCompactionHidden() {
  const context = getContext();
  const chat = context.chat ?? [];
  const indices = [];
  for (let i = 0; i < chat.length; i++) {
    if (isSmartMemoryHidden(chat[i])) {
      delete chat[i].extra[HIDE_FLAG];
      indices.push(i);
    }
  }
  for (const [start, end] of toRanges(indices)) {
    await hideChatMessageRange(start, end, true);
  }
  if (indices.length) smLog(`[SmartMemory] Restored ${indices.length} hidden messages.`);
  return indices.length;
}

/**
 * @returns {number} How many messages currently carry our hide flag.
 */
export function countSmartMemoryHidden() {
  return (getContext().chat ?? []).filter(isSmartMemoryHidden).length;
}
