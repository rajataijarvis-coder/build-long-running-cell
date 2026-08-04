import test from 'node:test';
import assert from 'node:assert';
import { GET } from './route';

test('status route returns an object with a state field', async () => {
  const res = await GET();
  const data = await res.json();
  assert.ok(typeof data === 'object');
  assert.ok('state' in data);
});
