import { buildApp } from './app';
import { makeDeps } from './bootstrap';

const deps = makeDeps();
const app = await buildApp(deps);
await app.listen({ port: deps.env.PORT, host: '0.0.0.0' });
const stop = async () => { await app.close(); await deps.db.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
