import { makeDeps } from './bootstrap';
import { Worker } from './jobs/queue';
import { cronSpecs, registerJobs } from './jobs/register';

/** Job worker: run 1+ instances; claims use SKIP LOCKED so they never double-process. */
const deps = makeDeps();
const worker = registerJobs(new Worker(deps.db), deps);
const specs = cronSpecs(deps);
let running = true;
process.on('SIGTERM', () => { running = false; });
process.on('SIGINT', () => { running = false; });
console.log(`worker ${worker.id} handling: ${worker.names().join(', ')}`);
let lastCron = 0;
while (running) {
  const now = deps.clock.now();
  try {
    if (now.getTime() - lastCron > 30_000) { await worker.tickCron(now, specs); lastCron = now.getTime(); }
    const n = await worker.runDue(now);
    if (n === 0) await new Promise((r) => setTimeout(r, 1000));
  } catch (e) {
    console.error('worker loop error', e);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
await deps.db.close();
