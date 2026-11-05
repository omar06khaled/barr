/**
 * Offline outbox (pure logic, no React Native imports → unit-testable).
 *
 * Field staff capture check-ins, reports, photos and dose confirmations offline. Each op gets a
 * client-generated UUID (opId) at capture time, so the server applies it exactly once no matter
 * how many times we retry. Ops are sent in capture order; photos are uploaded before the report
 * that references them. Conflicts (server already has a different report) are surfaced, never
 * silently overwritten.
 */
export type OpKind = 'check_in' | 'check_out' | 'report' | 'dose_confirm';
export type OpState = 'pending' | 'applied' | 'rejected' | 'conflict';

export interface PendingPhoto { localUri: string; uploadedKey?: string }
export interface OutboxOp {
  opId: string;
  kind: OpKind;
  payload: any;
  createdAt: string;
  state: OpState;
  attempts: number;
  lastError?: string;
  /** Only for 'report': photos still on the device. */
  photos?: PendingPhoto[];
}

export interface OutboxStore {
  all(): Promise<OutboxOp[]>;
  put(op: OutboxOp): Promise<void>;
}

export interface Transport {
  /** Returns per-op results from POST /field/sync. Throws on network failure. */
  sync(ops: { opId: string; kind: OpKind; payload: any }[]): Promise<{ opId: string; status: string; error?: string }[]>;
  /** Uploads one photo for a visit, returns the storage key. Throws on network failure. */
  uploadPhoto(visitId: string, parentId: string, localUri: string): Promise<string>;
}

export async function enqueue(store: OutboxStore, op: Omit<OutboxOp, 'state' | 'attempts'>) {
  await store.put({ ...op, state: 'pending', attempts: 0 });
}

export async function pendingCount(store: OutboxStore) {
  return (await store.all()).filter((o) => o.state === 'pending').length;
}

/**
 * Flush pending ops in order. Stops at the first network failure (keeps order for the next try).
 * Returns a summary for the UI.
 */
export async function flush(store: OutboxStore, t: Transport, parentIdForVisit: (visitId: string) => string | undefined) {
  const pending = (await store.all()).filter((o) => o.state === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let applied = 0, failed = 0, conflicts = 0;
  for (const op of pending) {
    try {
      if (op.kind === 'report' && op.photos?.some((p) => !p.uploadedKey)) {
        for (const p of op.photos) {
          if (p.uploadedKey) continue;
          const parentId = parentIdForVisit(op.payload.visitId);
          if (!parentId) throw new Error('missing_parent_for_visit');
          p.uploadedKey = await t.uploadPhoto(op.payload.visitId, parentId, p.localUri);
          await store.put(op); // remember progress: never re-upload a photo
        }
      }
      const payload = op.kind === 'report' ? { ...op.payload, photoKeys: (op.photos ?? []).map((p) => p.uploadedKey!) } : op.payload;
      const [res] = await t.sync([{ opId: op.opId, kind: op.kind, payload }]);
      if (!res) throw new Error('empty_response');
      if (res.status === 'applied' || res.status === 'duplicate') { op.state = 'applied'; applied++; }
      else if (res.status === 'conflict') { op.state = 'conflict'; op.lastError = res.error; conflicts++; }
      else if (res.error === 'retry_later') { op.attempts++; op.lastError = res.error; await store.put(op); failed++; break; }
      else { op.state = 'rejected'; op.lastError = res.error; failed++; }
      await store.put(op);
    } catch (e: any) {
      op.attempts++;
      op.lastError = e?.message ?? 'network';
      await store.put(op);
      failed++;
      break; // offline: keep order, try again later
    }
  }
  return { applied, failed, conflicts, remaining: await pendingCount(store) };
}

export class MemoryStore implements OutboxStore {
  ops = new Map<string, OutboxOp>();
  async all() { return [...this.ops.values()].map((o) => structuredClone(o)); }
  async put(op: OutboxOp) { this.ops.set(op.opId, structuredClone(op)); }
}
