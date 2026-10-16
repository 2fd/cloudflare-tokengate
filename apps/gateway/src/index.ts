// Worker entry point: HTTP via the app, the hourly cron, and the optional request-log queue.
import { createApp } from './app';
import { productionDeps } from './deps';
import { appEnv } from './env';
import { runCron } from './telemetry/cron';
import { consumeRequestLogBatch } from './telemetry/queue-consumer';
import type { RequestRecord } from './telemetry/types';

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    await runCron(productionDeps(appEnv(env), ctx));
  },
  async queue(batch, env, ctx) {
    await consumeRequestLogBatch(
      batch as MessageBatch<RequestRecord>,
      productionDeps(appEnv(env), ctx),
    );
  },
} satisfies ExportedHandler<Env>;
