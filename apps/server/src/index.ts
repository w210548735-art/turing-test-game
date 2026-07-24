import { buildServer } from "./server.js";

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const host = process.env.HOST ?? "127.0.0.1";
const { app } = await buildServer();

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error, "failed to start server");
  process.exitCode = 1;
}
