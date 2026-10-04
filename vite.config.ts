import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Dev-only: lets the F1 panel's "keep this seed" write the title-background
 * seed into src/data/title.json. Only the `seed` field is touched, and only a
 * non-negative integer is accepted. Not present in production builds.
 */
function devTitleSeed(): Plugin {
  const file = fileURLToPath(new URL('./src/data/title.json', import.meta.url));
  return {
    name: 'fine-line-dev-title-seed',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev/title-seed', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1000) req.destroy(); });
        req.on('end', () => {
          try {
            const { seed } = JSON.parse(body) as { seed: unknown };
            if (!Number.isInteger(seed) || (seed as number) < 0) throw new Error('seed must be a non-negative integer');
            const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
            json.seed = seed;
            writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
            res.end('ok');
          } catch (e) {
            res.statusCode = 400;
            res.end(String(e));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [devTitleSeed()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2020',
  },
});
