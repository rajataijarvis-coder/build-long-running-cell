import { NextResponse } from 'next/server';
import { cellFetch } from '@/lib/cell';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { data } = await cellFetch('/eval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
