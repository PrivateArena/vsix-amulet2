import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{shared,webview/src,src,pi-bridge}/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
