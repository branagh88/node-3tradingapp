// tests/multiselect-mobile.test.mjs — Phase 10 markup-level mobile-safety
// assertions for the compact multi-select: popover carries the fixed-position
// mobile rules, box-sizing guard, wrapping chip-row; no oversized inline widths.
// CSS application itself is covered by build/smoke + manual device check.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'style.css'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

function lastMobileBlock(source) {
  const marker = '@media (max-width: 860px)';
  const idx = source.lastIndexOf(marker);
  expect(idx).toBeGreaterThan(-1);
  const open = source.indexOf('{', idx);
  let depth = 1;
  let end = open + 1;
  while (depth > 0 && end < source.length) {
    if (source[end] === '{') depth += 1;
    if (source[end] === '}') depth -= 1;
    end += 1;
  }
  return source.slice(open, end);
}

describe('multi-select mobile safety (markup-level)', () => {
  it('popover has desktop max-height/overflow and box-sizing', () => {
    expect(css).toMatch(/\.ms-popover\s*{[^}]*max-height:\s*40vh/);
    expect(css).toMatch(/\.ms-popover\s*{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.ms-popover\s*{[^}]*box-sizing:\s*border-box/);
    // Never wider than the viewport on desktop either.
    expect(css).toMatch(/\.ms-popover\s*{[^}]*max-width:\s*calc\(100vw - 32px\)/);
  });

  it('mobile block switches popover to fixed full-width-minus-margins', () => {
    const block = lastMobileBlock(css);
    expect(block).toContain('.ms-popover');
    expect(block).toContain('position: fixed');
    expect(block).toContain('left: 16px');
    expect(block).toContain('right: 16px');
    expect(block).toContain('width: auto');
    expect(block).toMatch(/bottom:\s*calc\(72px \+ env\(safe-area-inset-bottom\)\)/);
    expect(block).not.toMatch(/top:\s*calc/);
    expect(block).toMatch(/z-index:\s*50/);
    expect(block).toContain('.chip-row');
    expect(block).toContain('flex-wrap: wrap');
  });

  it('chip-row wraps so chips can never force horizontal overflow', () => {
    expect(lastMobileBlock(css)).toMatch(/\.chip-row[^}]*flex-wrap:\s*wrap/);
  });

  it('index.html declares both instances with trigger + popover structure', () => {
    for (const p of ['rv', 'hd']) {
      expect(html).toContain(`id="${p}-ms-trigger"`);
      expect(html).toContain(`id="${p}-ms-popover"`);
      expect(html).toContain(`id="${p}-estimate"`);
    }
    expect(html).toContain('id="hd-fetch"');
    expect(html).toContain('GET HISTORICAL DATA');
    // Select all/Clear all ids are injected by buildMultiSelectPopoverHtml at wire-up.
  });

  it('no inline width greater than viewport units on popover/trigger elements', () => {
    // The static markup must not pin pixel widths that could overflow phones.
    const triggers = html.match(/<button[^>]*ms-trigger[^>]*>/g) || [];
    for (const t of triggers) expect(t).not.toMatch(/width:/);
    const popovers = html.match(/<div[^>]*ms-popover[^>]*>/g) || [];
    for (const p of popovers) expect(p).not.toMatch(/width/);
  });
});
