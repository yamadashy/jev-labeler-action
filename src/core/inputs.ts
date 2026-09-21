import { parse as parseYaml } from 'yaml';

/**
 * Parsing of the free-text action inputs.
 *
 * Kept away from `@actions/core` so the parsing rules can be tested directly,
 * and so the same rules apply to the smoke script.
 */

export const DEFAULT_EXCLUDE_LABELS = ['duplicate', 'invalid', 'wontfix', 'good first issue', 'help wanted'];

export const DEFAULT_THRESHOLD = 0.8;
export const DEFAULT_MAX_BODY_CHARS = 6000;

/**
 * Split a list input on newlines or commas.
 *
 * Both separators are accepted because a YAML block scalar is the comfortable
 * way to write a long list and a single line is the comfortable way to write a
 * short one. A label containing a comma cannot be expressed on one line; write
 * it on its own line instead.
 */
export function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Parse the `criteria` input: a YAML mapping of label name to a plain-language
 * condition. Returns an empty map for an empty input.
 */
export function parseCriteria(raw: string | undefined): Record<string, string> {
  if (!raw || raw.trim() === '') return {};

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new Error(`\`criteria\` is not valid YAML: ${(error as Error).message}`);
  }

  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      '`criteria` must be a YAML mapping of label name to a condition, for example `bug: reports a defect`.',
    );
  }

  const result: Record<string, string> = {};
  for (const [label, condition] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof condition !== 'string' || condition.trim() === '') {
      throw new Error(`\`criteria\` entry "${label}" must be a non-empty string describing when the label applies.`);
    }
    result[label.trim()] = condition.trim();
  }
  return result;
}

export function parseThreshold(raw: string | undefined): number {
  if (!raw || raw.trim() === '') return DEFAULT_THRESHOLD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`\`threshold\` must be a number between zero and one, got "${raw}".`);
  }
  return value;
}

export function parseMaxBodyChars(raw: string | undefined): number {
  if (!raw || raw.trim() === '') return DEFAULT_MAX_BODY_CHARS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`\`max-body-chars\` must be a positive whole number, got "${raw}".`);
  }
  return value;
}

/**
 * The per-pull-request budget for diff text, in characters. Zero means send the
 * file list without patches, which is the measured default.
 */
export function parseMaxDiffChars(raw: string | undefined): number {
  if (!raw || raw.trim() === '') return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`\`max-diff-chars\` must be a whole number, zero or more, got "${raw}".`);
  }
  return value;
}

export function parseBoolean(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['true', 'yes', 'on'].includes(value)) return true;
  if (['false', 'no', 'off'].includes(value)) return false;
  throw new Error(`Expected a boolean ("true" or "false"), got "${raw}".`);
}

/** Label names are matched case-insensitively, because that is how people type them. */
export function canonical(label: string): string {
  return label.trim().toLowerCase();
}
