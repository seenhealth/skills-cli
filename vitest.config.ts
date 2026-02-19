import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Disable file parallelism because some tests modify shared state
    // (e.g., ~/.agents/.skill-lock.json)
    fileParallelism: false,
  },
});
