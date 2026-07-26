import { loadConfig, validateConfig } from './config.mjs';
import { createControlPlane } from './app.mjs';

const config = loadConfig();
const validation = validateConfig(config);
for (const warning of validation.warnings) console.warn(`Configuration warning: ${warning}`);
if (validation.errors.length) {
  console.error(`Configuration error:\n- ${validation.errors.join('\n- ')}`);
  process.exit(1);
}

const app = await createControlPlane(config);
app.server.listen(config.port, config.host, () => {
  console.log(`OpenClaw delegation control plane listening on http://${config.host}:${config.port}`);
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`Received ${signal}; shutting down`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  await app.close();
  clearTimeout(force);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
