import { describe, expect, it } from 'vitest';
import {
  canonical,
  parseBoolean,
  parseCriteria,
  parseList,
  parseMaxBodyChars,
  parseThreshold,
} from '../../src/core/inputs.js';

describe('parseList', () => {
  it('splits on newlines', () => {
    expect(parseList('bug\nenhancement\n')).toEqual(['bug', 'enhancement']);
  });

  it('splits on commas and trims', () => {
    expect(parseList('bug, enhancement ,question')).toEqual(['bug', 'enhancement', 'question']);
  });

  it('keeps spaces inside a name', () => {
    expect(parseList('good first issue\nhelp wanted')).toEqual(['good first issue', 'help wanted']);
  });

  it('returns nothing for an empty input', () => {
    expect(parseList('')).toEqual([]);
    expect(parseList(undefined)).toEqual([]);
  });
});

describe('parseCriteria', () => {
  it('parses a YAML mapping', () => {
    expect(parseCriteria('bug: reports a defect\nquestion: asks how to do something')).toEqual({
      bug: 'reports a defect',
      question: 'asks how to do something',
    });
  });

  it('accepts a quoted key with spaces', () => {
    expect(parseCriteria('"needs more information": the report lacks steps')).toEqual({
      'needs more information': 'the report lacks steps',
    });
  });

  it('returns an empty map for an empty input', () => {
    expect(parseCriteria('')).toEqual({});
    expect(parseCriteria(undefined)).toEqual({});
  });

  it('rejects a list', () => {
    expect(() => parseCriteria('- bug\n- question')).toThrow(/mapping/);
  });

  it('rejects a non-string condition', () => {
    expect(() => parseCriteria('bug:\n  nested: yes')).toThrow(/non-empty string/);
  });
});

describe('parseThreshold', () => {
  it('defaults when empty', () => {
    expect(parseThreshold('')).toBe(0.8);
  });

  it('accepts the ends of the range', () => {
    expect(parseThreshold('0')).toBe(0);
    expect(parseThreshold('1')).toBe(1);
  });

  it('rejects a value outside the range', () => {
    expect(() => parseThreshold('1.5')).toThrow(/between zero and one/);
  });

  it('rejects text', () => {
    expect(() => parseThreshold('high')).toThrow();
  });
});

describe('parseMaxBodyChars', () => {
  it('defaults when empty', () => {
    expect(parseMaxBodyChars('')).toBe(6000);
  });

  it('rejects zero and fractions', () => {
    expect(() => parseMaxBodyChars('0')).toThrow();
    expect(() => parseMaxBodyChars('1.5')).toThrow();
  });
});

describe('parseBoolean', () => {
  it('reads the usual spellings', () => {
    expect(parseBoolean('true')).toBe(true);
    expect(parseBoolean('FALSE')).toBe(false);
  });

  it('falls back when empty', () => {
    expect(parseBoolean('', true)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(() => parseBoolean('maybe')).toThrow();
  });
});

describe('canonical', () => {
  it('lowercases and trims', () => {
    expect(canonical('  Good First Issue ')).toBe('good first issue');
  });
});
