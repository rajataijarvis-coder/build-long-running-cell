import { NextResponse } from 'next/server';

const CELL_URL = process.env.CELL_URL ?? 'http://localhost:3456';

export async function GET() {
  try {
    const res = await fetch(`${CELL_URL}/status`, { cache: 'no-store' });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ state: 'offline', error: (err as Error).message }, { status: 503 });
  }
}
