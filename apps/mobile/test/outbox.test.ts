import { describe, expect, it } from 'vitest';
import { MemoryStore, enqueue, flush, pendingCount, type Transport } from '../src/lib/outboxCore';

const visitId = 'v1';
function transport(opts: { offline?: () => boolean; results?: Record<string, string> } = {}) {
  const calls: string[] = [];
  const uploads: string[] = [];
  const t: Transport = {
    async sync(ops) {
      if (opts.offline?.()) throw new Error('network');
      calls.push(...ops.map((o) => `${o.kind}:${o.opId}:${(o.payload.photoKeys ?? []).join(',')}`));
      return ops.map((o) => ({ opId: o.opId, status: opts.results?.[o.opId] ?? 'applied', error: opts.results?.[o.opId] === 'conflict' ? 'already_submitted' : undefined }));
    },
    async uploadPhoto(_v, _p, uri) { if (opts.offline?.()) throw new Error('network'); uploads.push(uri); return `visits/${visitId}/${uri}.jpg`; },
  };
  return { t, calls, uploads };
}

describe('offline outbox', () => {
  it('keeps capture order, uploads photos before report, and survives going offline mid-flush', async () => {
    const s = new MemoryStore();
    await enqueue(s, { opId: 'a', kind: 'check_in', payload: { visitId }, createdAt: '2026-11-05T08:00:00Z' });
    await enqueue(s, { opId: 'b', kind: 'report', payload: { visitId, photoKeys: [] }, createdAt: '2026-11-05T08:40:00Z', photos: [{ localUri: 'p1' }, { localUri: 'p2' }] });
    await enqueue(s, { opId: 'c', kind: 'check_out', payload: { visitId }, createdAt: '2026-11-05T08:45:00Z' });
    let online = false;
    const { t, calls, uploads } = transport({ offline: () => !online });
    expect(await flush(s, t, () => 'parent')).toMatchObject({ applied: 0, remaining: 3 });
    online = true;
    const r = await flush(s, t, () => 'parent');
    expect(r).toMatchObject({ applied: 3, remaining: 0 });
    expect(calls).toEqual(['check_in:a:', 'report:b:visits/v1/p1.jpg,visits/v1/p2.jpg', 'check_out:c:']);
    expect(uploads).toEqual(['p1', 'p2']);
  });

  it('never re-uploads a photo already uploaded before connectivity dropped', async () => {
    const s = new MemoryStore();
    await enqueue(s, { opId: 'b', kind: 'report', payload: { visitId }, createdAt: '1', photos: [{ localUri: 'p1' }, { localUri: 'p2' }] });
    let n = 0;
    const uploads: string[] = [];
    const t: Transport = {
      async uploadPhoto(_v, _p, uri) { if (++n === 2) throw new Error('network'); uploads.push(uri); return `k-${uri}`; },
      async sync(ops) { return ops.map((o) => ({ opId: o.opId, status: 'applied' })); },
    };
    await flush(s, t, () => 'parent');
    expect(await pendingCount(s)).toBe(1);
    n = 10;
    await flush(s, t, () => 'parent');
    expect(uploads).toEqual(['p1', 'p2']);
    expect(await pendingCount(s)).toBe(0);
  });

  it('marks conflicts and rejections without blocking later ops', async () => {
    const s = new MemoryStore();
    await enqueue(s, { opId: 'x', kind: 'report', payload: { visitId }, createdAt: '1' });
    await enqueue(s, { opId: 'y', kind: 'dose_confirm', payload: {}, createdAt: '2' });
    const { t } = transport({ results: { x: 'conflict' } });
    const r = await flush(s, t, () => 'parent');
    expect(r).toMatchObject({ applied: 1, conflicts: 1, remaining: 0 });
    expect((await s.all()).find((o) => o.opId === 'x')!.state).toBe('conflict');
  });
});
