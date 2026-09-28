export const config = {
  glomopay: {
    apiHost: process.env.API_HOST,
  },
  http: {
    port: Number(process.env.PORT) || 3000,
    host: process.env.HOST || '127.0.0.1',
  },
  // Read when the app is created, not at import, so each app instance sees the current env.
  analytics: {
    get mixpanelToken(): string | undefined {
      return process.env.MIXPANEL_TOKEN || undefined;
    },
    get mixpanelHost(): string | undefined {
      return process.env.MIXPANEL_HOST || undefined;
    },
  },
  auth: {
    mcpPublicKey: process.env.GLOMO_MCP_PUBLIC_KEY,
    mcpAudience: process.env.GLOMO_MCP_AUDIENCE,
  },
};
