// Starts the demo store for manual use:
//   REPRO_STORE_FIXTURE=correct|faulty [PORT=4173] npm run store
import { createStoreServer } from './server.ts';
import { FIXTURES, isFixture } from './pricing.ts';

const fixture = process.env.REPRO_STORE_FIXTURE;
if (!isFixture(fixture)) {
  console.error(`Set REPRO_STORE_FIXTURE to one of: ${FIXTURES.join(', ')}`);
  process.exit(1);
}

const port = Number(process.env.PORT ?? 4173);
createStoreServer(fixture).listen(port, '127.0.0.1', () => {
  console.log(`Demo store (${fixture}) at http://127.0.0.1:${port}/`);
});
