/**
 * Entry point of the model emulator container (deploy/local/services/model-emulator.compose.yaml, profile `models`).
 * TEST EMULATOR (WP-08): never part of a production composition. Listens on all interfaces INSIDE the container;
 * compose publishes the ports on 127.0.0.1 only.
 *
 *   VSP_MODEL_EMULATOR_HTTPS_PORT  HTTPS listener, per-host certificates registered through the admin API (default 8443)
 *   VSP_MODEL_EMULATOR_ADMIN_PORT  admin API, plain HTTP (default 8080)
 *   VSP_MODEL_EMULATOR_HTTP_PORT   optional plain HTTP listener (unset: none)
 */
import { ModelEmulator } from "./server.js";

const port = (name: string, fallback: number | null): number | null => {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) throw new Error(`${name} must be a port number`);
  return n;
};

const emulator = new ModelEmulator({
  bindAddress: "0.0.0.0",
  httpsPort: port("VSP_MODEL_EMULATOR_HTTPS_PORT", 8443),
  adminPort: port("VSP_MODEL_EMULATOR_ADMIN_PORT", 8080),
  httpPort: port("VSP_MODEL_EMULATOR_HTTP_PORT", null),
  frameDelayMs: 5,
});

await emulator.start();
console.error(JSON.stringify({ event: "model_emulator.listening", httpsPort: emulator.httpsPort, adminPort: emulator.adminPort }));

const stop = () => {
  void emulator.stop().then(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
