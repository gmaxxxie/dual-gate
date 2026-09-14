import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTabletMode } from '../src/rotate.js';

test('tablet mode is off when keyboard attached', () => {
  assert.equal(detectTabletMode(true), false);
});
