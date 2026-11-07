import { z } from "zod"
import path from "path"
import os from "os"
import dotenv from "dotenv"

dotenv.config()

const defaultSessionFile = path.join(os.homedir(), ".picnic-session.json")
const defaultDeviceFile = path.join(os.homedir(), ".picnic-device.json")

const configSchema = z.object({
  PICNIC_USERNAME: z.string(),
  PICNIC_PASSWORD: z.string(),
  PICNIC_COUNTRY_CODE: z.enum(["NL", "DE", "FR"]).default("NL"),
  PICNIC_API_VERSION: z.string().default("15"),
  PICNIC_DEVICE_ID: z.string().optional(),
  PICNIC_DEVICE_FILE: z.string().default(defaultDeviceFile),
  PICNIC_AGENT: z.string().optional(),
  ENABLE_HTTP_SERVER: z
    .string()
    .transform((val) => val === "true")
    .default("false"),
  HTTP_PORT: z
    .string()
    .transform((val) => parseInt(val, 10))
    .default("3000"),
  HTTP_HOST: z.string().default("localhost"),
  HTTP_AUTH_TOKEN: z.string().optional(),
  HTTP_AUTH_HEADER_NAME: z.string().default("x-mcp-token"),
  // Max requests per client IP per window. A weekly meal plan (searches + ~30 cart adds) needs headroom.
  HTTP_RATE_LIMIT_MAX_REQUESTS: z
    .string()
    .transform((val) => parseInt(val, 10))
    .default("1000"),
  HTTP_RATE_LIMIT_WINDOW_MS: z
    .string()
    .transform((val) => parseInt(val, 10))
    .default(String(15 * 60 * 1000)),
  // Per-request timeout; kept above the 60s tool timeout so slow Picnic calls finish with a
  // proper tool result instead of an HTTP 408.
  HTTP_REQUEST_TIMEOUT_MS: z
    .string()
    .transform((val) => parseInt(val, 10))
    .default("75000"),
  PICNIC_SESSION_FILE: z.string().default(defaultSessionFile),
  // Picnic auth key used when no session file exists (e.g. on a host without a persistent
  // volume). Lets deployments run without a volume, so a redeploy causes no downtime.
  PICNIC_AUTH_KEY: z.string().optional(),
  // When "true", print the auth key and device id to the log at startup and after a login, so
  // they can be copied into PICNIC_AUTH_KEY / PICNIC_DEVICE_ID. Turn it off again afterwards.
  PICNIC_LOG_CREDENTIALS: z
    .string()
    .transform((val) => val === "true")
    .default("false"),
})

export const config = configSchema.parse(process.env)
