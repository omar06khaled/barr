import * as SQLite from 'expo-sqlite';
import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import * as ImageManipulator from 'expo-image-manipulator';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { api } from './api';
import { MemoryStore, enqueue as enqueueCore, flush, pendingCount, type OutboxOp, type OutboxStore, type PendingPhoto, type OpKind } from './outboxCore';

// Devices: SQLite (survives restarts and reboots). Web build is a developer preview only → in-memory.
const web = Platform.OS === 'web';
const db = web ? null : SQLite.openDatabaseSync('barr-field.db');
db?.execSync(`create table if not exists outbox (op_id text primary key, created_at text not null, json text not null);
              create table if not exists cache (key text primary key, json text not null, updated_at text not null);`);
const memStore = new MemoryStore();
const memCache = new Map<string, string>();

export const sqliteStore: OutboxStore = db
  ? {
      async all() { return (await db.getAllAsync<{ json: string }>('select json from outbox order by created_at')).map((r) => JSON.parse(r.json) as OutboxOp); },
      async put(op) { await db.runAsync('insert or replace into outbox (op_id, created_at, json) values (?,?,?)', [op.opId, op.createdAt, JSON.stringify(op)]); },
    }
  : memStore;

/** Cached visit packages so a visit can be opened and completed with no signal. */
export const cache = {
  async get<T>(key: string): Promise<T | null> {
    if (!db) { const v = memCache.get(key); return v ? (JSON.parse(v) as T) : null; }
    const r = await db.getFirstAsync<{ json: string }>('select json from cache where key=?', [key]);
    return r ? (JSON.parse(r.json) as T) : null;
  },
  async set(key: string, v: unknown) {
    if (!db) { memCache.set(key, JSON.stringify(v)); return; }
    await db.runAsync('insert or replace into cache (key, json, updated_at) values (?,?,?)', [key, JSON.stringify(v), new Date().toISOString()]);
  },
};

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export async function capture(kind: OpKind, payload: any, photos?: PendingPhoto[]) {
  await enqueueCore(sqliteStore, { opId: Crypto.randomUUID(), kind, payload, createdAt: new Date().toISOString(), photos });
  notify();
  void syncNow();
}

/** F6: compress on device before storing (max 1600px, JPEG 0.7). */
export async function compressPhoto(uri: string) {
  const r = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: 1600 } }], { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG });
  return r.uri;
}

async function uploadPhoto(visitId: string, parentId: string, localUri: string) {
  const signed = await api<{ key: string; url: string; headers: Record<string, string> }>('/uploads', { method: 'POST', body: { purpose: 'visit_photo', parentId, visitId, contentType: 'image/jpeg' } });
  const blob = await (await fetch(localUri)).blob();
  const r = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: blob });
  if (!r.ok) throw new Error(`upload_${r.status}`);
  return signed.key;
}

let running: Promise<unknown> | null = null;
export function syncNow() {
  running ??= (async () => {
    const state = await NetInfo.fetch();
    if (!state.isConnected) return;
    const packages = new Map<string, string>();
    for (const op of await sqliteStore.all()) {
      if (op.kind !== 'report') continue;
      const pkg = await cache.get<{ parent: { id: string } }>(`visit:${op.payload.visitId}`);
      if (pkg) packages.set(op.payload.visitId, pkg.parent.id);
    }
    await flush(sqliteStore, { sync: async (ops) => (await api<{ results: any[] }>('/field/sync', { method: 'POST', body: { ops } })).results, uploadPhoto }, (v) => packages.get(v));
  })().finally(() => { running = null; notify(); });
  return running;
}

/** Pending count + "offline" flag for the sync banner; flushes whenever connectivity returns and every 30 s. */
export function useOutbox() {
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(true);
  const [problems, setProblems] = useState<OutboxOp[]>([]);
  useEffect(() => {
    const refresh = async () => {
      setPending(await pendingCount(sqliteStore));
      setProblems((await sqliteStore.all()).filter((o) => o.state === 'conflict' || o.state === 'rejected'));
    };
    listeners.add(refresh);
    refresh();
    const unsub = NetInfo.addEventListener((s) => { setOnline(!!s.isConnected); if (s.isConnected) void syncNow(); });
    const id = setInterval(() => void syncNow(), 30_000);
    return () => { listeners.delete(refresh); unsub(); clearInterval(id); };
  }, []);
  return { pending, online, problems, syncNow };
}
