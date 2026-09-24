import path from 'path';

import { createApp } from '@/core/app/app.module';
import { config } from '@/features/app-config/app-config.module';

(async () => {
  const app = await createApp({
    specPath: path.resolve(__dirname, 'openapi.json'),
    apiHost: config.glomopay.apiHost,
  });

  app.listen(config.http.port, config.http.host, () => {
    console.error(`Glomopay MCP Server running on HTTP ${config.http.host}:${config.http.port}/mcp`);
  });
})();
