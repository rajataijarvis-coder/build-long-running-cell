import assert from 'node:assert';
import test from 'node:test';
import { CELL_URL } from './cell';

test('CELL_URL has a default value', () => {
  assert.ok(CELL_URL.length > 0, 'CELL_URL should not be empty');
  assert.ok(CELL_URL.startsWith('http'), 'CELL_URL should be an HTTP URL');
});
