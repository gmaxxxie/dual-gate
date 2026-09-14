import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTabletMode } from '../src/rotate.js';

test('tablet mode is off when keyboard attached', () => {
  assert.equal(detectTabletMode(true), false);
});

test('tablet mode is on when keyboard detached', () => {
  assert.equal(detectTabletMode(false), true);
});

test('tablet mode is on when attachment state is undefined', () => {
  assert.equal(detectTabletMode(undefined), true);
});
