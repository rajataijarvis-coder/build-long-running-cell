import { NextResponse } from 'next/server';

const CELL_URL = process.env.CELL_URL ?? 'http://localhost:3456';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const query = searchParams.get('query') ?? '';
    const kind = searchParams.get('kind') ?? '';
    const missionId = searchParams.get('missionId') ?? '';
    const topK = searchParams.get('topK') ?? '5';
    const url = new URL(`${CELL_URL}/memory`);
    if (query) url.searchParams.set('query', query);
    if (kind) url.searchParams.set('kind', kind);
    if (missionId) url.searchParams.set('missionId', missionId);
    url.searchParams.set('topK', topK);
    const res = await fetch(url.toString(), { cache: 'no-store' });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
