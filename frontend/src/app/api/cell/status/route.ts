import { NextResponse } from 'next/server';
import { cellFetch } from '@/lib/cell';

export async function GET() {
  try {
    const { data } = await cellFetch('/status');
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { state: 'offline', error: (err as Error).message },
      { status: 503 }
    );
  }
}
