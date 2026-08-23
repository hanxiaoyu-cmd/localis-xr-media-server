import path from 'node:path';
import { startProdServer } from 'vinext/server/prod-server';

const port = Number(process.env.LOCALIS_FRONTEND_PORT || 3210);
const host = '127.0.0.1';
const outDir = path.resolve(process.cwd(), 'dist');

const { server } = await startProdServer({ port, host, outDir });

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
