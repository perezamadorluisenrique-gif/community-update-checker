import test from 'node:test';
import assert from 'node:assert/strict';

import { neutralizeNotes } from '../src/notes.ts';

test('a fence loses its language so no code-block processor runs', () => {
  const md = '## Fixed\n```dataviewjs\ndv.paragraph("x")\n```\nafter';
  assert.equal(neutralizeNotes(md), '## Fixed\n```\ndv.paragraph("x")\n```\nafter');
});

test('tilde fences, longer fences and quoted or indented fences are covered', () => {
  assert.equal(neutralizeNotes('~~~js {run}\nx\n~~~'), '~~~\nx\n~~~');
  assert.equal(neutralizeNotes('````python title="a"\nx\n````'), '````\nx\n````');
  assert.equal(neutralizeNotes('> ```ad-note\n> x\n> ```'), '> ```\n> x\n> ```');
  assert.equal(neutralizeNotes('  ```base\nx\n  ```'), '  ```\nx\n  ```');
});

test('double brackets and embeds are escaped', () => {
  assert.equal(neutralizeNotes('see [[Note]] and ![[Image.png]]'), 'see \\[\\[Note]] and !\\[\\[Image.png]]');
});

test('ordinary Markdown is untouched', () => {
  const md = '- fixed **bug**\n- `inline code` and [link](https://x.y)\n```\nplain\n```';
  assert.equal(neutralizeNotes(md), md);
});
