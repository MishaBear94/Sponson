import { Registry } from "@sponson/core";
import { clerkAdapter } from "./clerk.js";
import { neonAdapter } from "./neon.js";
import { dopplerSecretSource, envSecretSource, opSecretSource } from "./secrets.js";
import { vercelAdapter } from "./vercel.js";

export * from "./http.js";
export * from "./neon.js";
export * from "./vercel.js";
export * from "./clerk.js";
export * from "./secrets.js";

/** Every built-in adapter and secret source. The CLI uses this; tests build narrower registries. */
export function createRegistry(): Registry {
  return new Registry().addAdapter(neonAdapter).addAdapter(vercelAdapter).addAdapter(clerkAdapter).addSecretSource(envSecretSource).addSecretSource(dopplerSecretSource()).addSecretSource(opSecretSource());
}
