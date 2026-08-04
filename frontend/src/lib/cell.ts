export const CELL_URL = process.env.CELL_URL ?? 'http://localhost:3456';

export async function cellFetch(path: string, init?: RequestInit) {
  const url = `${CELL_URL}${path}`;
  const res = await fetch(url, { ...init, cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}
