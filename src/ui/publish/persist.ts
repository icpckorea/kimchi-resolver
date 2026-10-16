/**
 * Prepare-page input persistence (publish-modes spec §4 step 2).
 *
 * The operator's inputs live in the browser's localStorage so a reload keeps
 * them. The key holds the publish mode and the contest (id or spotboard base
 * plus title), so preliminary values never leak into the regional page and a
 * previous contest's values never leak into this one (Review Focus 4).
 *
 * Every storage access is wrapped: a private window, blocked site data or a
 * full quota reads as "nothing stored" and never throws. A stored value of
 * the wrong shape (an older build, a hand edit) is refused by the parsers
 * below and also reads as "nothing stored".
 *
 * Framework-free: no React, no store import.
 */

import { z } from 'zod';
import type { AppConfig } from '@core/config';
import {
  regionalSimInputsSchema,
  type PublishMode,
  type RegionalSimInputs,
} from '@core/publishState';

/** The part of the Web Storage API this module uses (injectable for tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Preliminary prepare-page inputs (spec §5.2). null = not entered yet. */
export interface PrelimInputs {
  totalTeams: number | null;
  topN: number;
  k: number | null;
  ineligibleTeamIds: string[];
}

const KEY_PREFIX = 'kimchi.publish:';

/** 'kimchi.publish:' + mode + ':' + (contestId || apiBase) + ':' + contestTitle */
export function publishStorageKey(
  config: AppConfig,
  contestTitle: string,
  mode: PublishMode,
): string {
  const contest = config.source.contestId || config.source.apiBase;
  return `${KEY_PREFIX}${mode}:${contest}:${contestTitle}`;
}

/**
 * `undefined` → the browser's localStorage (the getter itself can throw);
 * `null` → no storage at all.
 */
function resolveStorage(storage: StorageLike | null | undefined): StorageLike | null {
  if (storage !== undefined) return storage;
  try {
    return (globalThis.localStorage as StorageLike | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads and JSON-parses one stored value. Returns null when nothing is
 * stored, on any storage or JSON error, and when `parse` refuses the value.
 */
export function loadPublishInputs<T>(
  key: string,
  storage?: StorageLike | null,
  parse?: (raw: unknown) => T | null,
): T | null {
  try {
    const target = resolveStorage(storage);
    if (target === null) return null;
    const text = target.getItem(key);
    if (text === null) return null;
    const raw: unknown = JSON.parse(text);
    return parse !== undefined ? parse(raw) : (raw as T);
  } catch {
    return null;
  }
}

/** Stores one value as JSON. Storage errors are swallowed. */
export function savePublishInputs(key: string, value: unknown, storage?: StorageLike | null): void {
  try {
    resolveStorage(storage)?.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or blocked storage: the inputs still work for this session.
  }
}

/** Removes one stored value ("config 값으로 되돌리기"). Storage errors are swallowed. */
export function clearPublishInputs(key: string, storage?: StorageLike | null): void {
  try {
    resolveStorage(storage)?.removeItem(key);
  } catch {
    // Nothing to do: the next load fails the same way and reads as empty.
  }
}

// ---------------------------------------------------------------------------
// Stored value parsers (strict: unknown keys are refused)
// ---------------------------------------------------------------------------

const count = z.number().int().nonnegative();

const prelimInputsSchema = z
  .object({
    totalTeams: z.number().int().positive().nullable(),
    topN: count,
    k: count.nullable(),
    ineligibleTeamIds: z.array(z.string()),
  })
  .strict() satisfies z.ZodType<PrelimInputs>;

export function parseStoredPrelimInputs(raw: unknown): PrelimInputs | null {
  const result = prelimInputsSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function parseStoredRegionalInputs(raw: unknown): RegionalSimInputs | null {
  const result = regionalSimInputsSchema.safeParse(raw);
  return result.success ? result.data : null;
}
