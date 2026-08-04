import { NextResponse } from 'next/server';
import { cellFetch } from '@/lib/cell';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = searchParams.get('limit') ?? '20';
    const { data } = await cellFetch(`/eval/runs?limit=${limit}`, { cache: 'no-store' });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
