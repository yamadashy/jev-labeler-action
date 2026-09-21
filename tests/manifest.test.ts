import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The runner loads action.yml with rules the unit tests never touch: it
// evaluates `${{ }}` everywhere, including inside descriptions, where only a
// few contexts exist, and its YAML reader rejects an unquoted ": " in a plain
// scalar. Both slipped through once and failed every run at "Set up job".
const source = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');

describe('action.yml', () => {
  it('uses expressions only for the github-token default', () => {
    const expressions = source.match(/\$\{\{[^}]*\}\}/g) ?? [];
    expect(expressions).toEqual(['${{ github.token }}']);
  });

  it('has no unquoted ": " inside a single-line plain scalar', () => {
    const offenders = source
      .split('\n')
      .filter((line) => /^\s+(description|default): [^'">|]/.test(line))
      .filter((line) => line.replace(/^\s+\w+: /, '').includes(': '));
    expect(offenders).toEqual([]);
  });

  it('declares every input with a string description', () => {
    const manifest = parse(source) as { inputs: Record<string, { description?: unknown }> };
    for (const [name, input] of Object.entries(manifest.inputs)) {
      expect(typeof input.description, name).toBe('string');
    }
  });
});
