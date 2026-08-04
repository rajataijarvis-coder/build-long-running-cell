import { NextResponse } from 'next/server';
import { cellFetch } from '@/lib/cell';

export async function GET() {
  try {
    const { data } = await cellFetch('/reviews/pending');
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
