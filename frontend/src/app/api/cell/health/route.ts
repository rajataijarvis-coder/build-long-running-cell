import { NextResponse } from 'next/server';
import { cellFetch } from '@/lib/cell';

export async function GET() {
  try {
    const { data } = await cellFetch('/health');
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { ok: false, status: 'offline', error: (err as Error).message },
      { status: 503 }
    );
  }
}
