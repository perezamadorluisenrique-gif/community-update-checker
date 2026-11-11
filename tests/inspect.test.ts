import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectUrl } from '../src/inspect.ts';

test('the link points to the Plugin Inspector with the plugin id', () => {
  assert.equal(inspectUrl('typography-as-you-type'), 'https://perezamadorluisenrique-gif.github.io/plugin-inspector/?q=typography-as-you-type');
});

test('the id is escaped so it cannot add parameters', () => {
  assert.equal(inspectUrl('a&b=c d'), 'https://perezamadorluisenrique-gif.github.io/plugin-inspector/?q=a%26b%3Dc%20d');
});
