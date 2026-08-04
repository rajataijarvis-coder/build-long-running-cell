import test from 'node:test';
import assert from 'node:assert';
import { GET } from './route';

test('reviews route returns an object with a reviews field', async () => {
  const res = await GET(new Request('http://localhost:3000/api/cell/reviews?status=pending'));
  const data = await res.json();
  assert.ok(typeof data === 'object');
  assert.ok('reviews' in data);
});
