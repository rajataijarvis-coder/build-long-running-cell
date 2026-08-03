import { NextResponse } from 'next/server';

const CELL_URL = process.env.CELL_URL ?? 'http://localhost:3456';

export async function POST() {
  try {
    const res = await fetch(`${CELL_URL}/tick`, { method: 'POST', cache: 'no-store' });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
