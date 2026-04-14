#!/usr/bin/env node
import { startMcpServer } from "./server.js";

startMcpServer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
