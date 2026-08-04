import { NextResponse } from 'next/server';

const CELL_URL = process.env.CELL_URL ?? 'http://localhost:3456';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const params = new URLSearchParams();
    const kind = searchParams.get('kind');
    const limit = searchParams.get('limit');
    if (kind) params.set('kind', kind);
    if (limit) params.set('limit', limit);
    const res = await fetch(`${CELL_URL}/failures?${params.toString()}`, { cache: 'no-store' });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
