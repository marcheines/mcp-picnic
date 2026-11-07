import { createMcpHandler } from "@modelcontextprotocol/server"
import { toNodeHandler } from "@modelcontextprotocol/node"
import express, { Request, Response, NextFunction } from "express"
import cors from "cors"
import { BaseTransportServer } from "./base.js"
import { TransportError, ErrorCode, ErrorUtils } from "../types/errors.js"
import { createRateLimitMiddleware, RateLimitConfig } from "../utils/rate-limiter.js"
import { timingSafeEqual } from "crypto"

/**
 * Configuration options for the HTTP server
 */
export interface StreamableHttpServerOptions {
  port?: number
  host?: string
  authToken?: string
  authHeaderName?: string
  corsOptions?: cors.CorsOptions
  rateLimitConfig?: RateLimitConfig
  requestTimeoutMs?: number
  maxRequestSizeBytes?: number
  enableRequestLogging?: boolean
}

/**
 * Class to handle HTTP server setup and configuration using the official MCP StreamableHTTP transport
 */
export class StreamableHttpServer extends BaseTransportServer {
  private app: express.Application
  // @ts-expect-error - This property will be initialized in the start() method
  private server: import("http").Server
  private port: number
  private host: string
  private options: StreamableHttpServerOptions
  private rateLimiter?: ReturnType<typeof createRateLimitMiddleware>
  private activeRequests = 0
  // One handler serves both protocol eras: 2026-07-28 requests (server/discover, per-request
  // _meta envelope) and 2025-era requests (initialize handshake) via the SDK's stateless fallback.
  private mcpHandler = createMcpHandler(() => this.createConfiguredServer(), {
    legacy: "stateless",
    responseMode: "json",
    onerror: (error: Error) => console.error(`[MCP transport] ${error.message}`),
  })
  private nodeHandler = toNodeHandler(this.mcpHandler)

  /**
   * Create a new HTTP server for MCP over HTTP
   *
   * @param options Configuration options
   */
  constructor(options: StreamableHttpServerOptions = {}) {
    super()
    this.options = {
      port: 3000,
      host: "localhost",
      authHeaderName: "x-mcp-token",
      corsOptions: { origin: "*" },
      rateLimitConfig: { windowMs: 15 * 60 * 1000, maxRequests: 100 },
      requestTimeoutMs: 75000, // above the 60s tool timeout
      maxRequestSizeBytes: 1024 * 1024 * 10, // 10MB
      enableRequestLogging: true,
      ...options,
    }
    this.app = express()

    this.port = this.options.port!
    this.host = this.options.host!

    // Set up middleware
    this.setupMiddleware()

    // Set up routes
    this.setupRoutes()
  }

  /**
   * Set up middleware for the Express app
   */
  private setupMiddleware(): void {
    // Request logging middleware
    if (this.options.enableRequestLogging) {
      this.app.use((req: Request, res: Response, next: NextFunction) => {
        const start = Date.now()
        console.error(`[${new Date().toISOString()}] ${req.method} ${req.url} - ${req.ip}`)

        res.on("finish", () => {
          const duration = Date.now() - start
          console.error(
            `[${new Date().toISOString()}] ${req.method} ${req.url} - ${res.statusCode} - ${duration}ms`,
          )
        })
        next()
      })
    }

    // Rate limiting middleware
    if (this.options.rateLimitConfig) {
      this.rateLimiter = createRateLimitMiddleware(this.options.rateLimitConfig)
      this.app.use(this.rateLimiter.middleware)
    }

    if (this.options.authToken) {
      this.app.use((req: Request, res: Response, next: NextFunction) => {
        if (req.path === "/health") {
          return next()
        }

        const headerName = this.options.authHeaderName ?? "x-mcp-token"
        const headerToken = req.header(headerName)
        const authorizationHeader = req.header("authorization")

        const headerTokenValid = this.compareAuthTokens(headerToken)
        const bearerTokenValid =
          typeof authorizationHeader === "string" &&
          authorizationHeader.startsWith("Bearer ") &&
          this.compareAuthTokens(authorizationHeader.slice(7))

        const hasValidToken = headerTokenValid || bearerTokenValid

        if (!hasValidToken) {
          return res.status(401).json({
            error: "Unauthorized",
            message: "Missing or invalid authentication token. Provide a valid auth header.",
          })
        }

        return next()
      })
    }

    // Request timeout middleware
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const timeout = setTimeout(() => {
        if (!res.headersSent) {
          const error = new TransportError(ErrorCode.TRANSPORT_TIMEOUT, "Request timeout", {
            timeoutMs: this.options.requestTimeoutMs,
          })
          res.status(408).json({
            jsonrpc: "2.0",
            error: error.toMCPError(),
            id: null,
          })
        }
      }, this.options.requestTimeoutMs)

      res.on("finish", () => clearTimeout(timeout))
      res.on("close", () => clearTimeout(timeout))
      next()
    })

    // Configure CORS
    this.app.use(
      cors(
        this.options.corsOptions || {
          origin: "*",
          methods: ["GET", "POST", "DELETE"],
          allowedHeaders: ["Content-Type", "Authorization", "MCP-Protocol-Version"],
        },
      ),
    )

    // Configure JSON body parsing with size limit
    this.app.use(
      express.json({
        limit: this.options.maxRequestSizeBytes,
        verify: (req: any, res: Response, buf: Buffer) => {
          if (buf.length > this.options.maxRequestSizeBytes!) {
            const error = new TransportError(ErrorCode.INVALID_REQUEST, "Request body too large", {
              maxSize: this.options.maxRequestSizeBytes,
              actualSize: buf.length,
            })
            throw error
          }
        },
      }),
    )

    // Global error handler for middleware
    this.app.use((error: any, req: Request, res: Response, next: NextFunction) => {
      ErrorUtils.logError(error, "HTTP Middleware")

      if (res.headersSent) {
        return next(error)
      }

      if (ErrorUtils.isMCPError(error)) {
        return res.status(error.statusCode).json({
          jsonrpc: "2.0",
          error: error.toMCPError(),
          id: null,
        })
      }

      // Handle specific Express errors
      if (error.type === "entity.too.large") {
        const transportError = new TransportError(
          ErrorCode.INVALID_REQUEST,
          "Request body too large",
        )
        return res.status(413).json({
          jsonrpc: "2.0",
          error: transportError.toMCPError(),
          id: null,
        })
      }

      // Generic error response
      const genericError = new TransportError(ErrorCode.INTERNAL_ERROR, "Internal server error")
      res.status(500).json({
        jsonrpc: "2.0",
        error: genericError.toMCPError(),
        id: null,
      })
    })
  }

  private compareAuthTokens(token: string | undefined): boolean {
    if (!this.options.authToken || typeof token !== "string") {
      return false
    }

    const provided = Buffer.from(token)
    const expected = Buffer.from(this.options.authToken)
    if (provided.length !== expected.length) {
      return false
    }

    return timingSafeEqual(provided, expected)
  }

  /**
   * Set up the routes for MCP over HTTP
   */
  private setupRoutes(): void {
    // MCP endpoint. Every request is handled on its own (no sessions), so nothing can expire,
    // get lost on a redeploy, or be missing from a request. GET/DELETE are answered by the SDK.
    this.app.all("/mcp", async (req: Request, res: Response) => {
      try {
        await this.handleMcpRequest(req, res)
      } catch (error) {
        ErrorUtils.logError(error, "MCP Request Handler")
        if (!res.headersSent) {
          const errorResponse = ErrorUtils.createSafeErrorResponse(error)
          const status = ErrorUtils.isMCPError(error) ? error.statusCode : 500
          res.status(status).json({
            jsonrpc: "2.0",
            error: errorResponse,
            id: null,
          })
        }
      }
    })

    // Add a health check endpoint
    this.app.get("/health", (_req: Request, res: Response) => {
      try {
        const stats = this.rateLimiter?.limiter.getStats()
        res.status(200).json({
          status: "ok",
          timestamp: new Date().toISOString(),
          mode: "stateless",
          activeRequests: this.activeRequests,
          rateLimit: stats || null,
        })
      } catch (error) {
        ErrorUtils.logError(error, "Health Check")
        res.status(500).json({
          status: "error",
          message: "Health check failed",
        })
      }
    })
  }

  /**
   * Handle one MCP request through the SDK's dual-era handler.
   *
   * Claude's connector now speaks MCP 2026-07-28: it probes with server/discover and sends every
   * request with a per-request _meta envelope. SDK v1 only knew the 2025 handshake, answered the
   * probe with "Method not found" and could not serve modern requests, so the connector dropped.
   * The Picnic client and its login are process-wide, so nothing per-request is lost.
   */
  private async handleMcpRequest(req: Request, res: Response): Promise<void> {
    const headerVersion = req.headers["mcp-protocol-version"]
    this.logExchange(req, res, typeof headerVersion === "string" ? headerVersion : undefined)

    this.activeRequests++
    res.on("close", () => {
      this.activeRequests--
    })
    await this.nodeHandler(req, res, req.method === "POST" ? req.body : undefined)
  }

  /**
   * Log one line per MCP request: JSON-RPC method(s), tool name, protocol versions, HTTP status
   * and any JSON-RPC error in the response. The access log only shows "POST /mcp 200", which
   * cannot tell a failed handshake from a successful one. Tool arguments are never logged.
   */
  private logExchange(req: Request, res: Response, headerVersion: string | undefined): void {
    if (!this.options.enableRequestLogging) return

    if (req.method !== "POST") {
      res.on("finish", () => console.error(`[MCP] ${req.method} -> ${res.statusCode}`))
      return
    }
    const messages: any[] = Array.isArray(req.body) ? req.body : [req.body]
    const describe = (msg: any): string => {
      if (!msg || typeof msg !== "object") return "invalid"
      const method = typeof msg.method === "string" ? msg.method : "response"
      const parts = [method]
      if (method === "tools/call" && typeof msg.params?.name === "string") {
        parts[0] = `tools/call(${msg.params.name})`
      }
      if (method === "initialize") {
        const client = msg.params?.clientInfo
        parts.push(`wants=${msg.params?.protocolVersion ?? "?"}`)
        if (client?.name) parts.push(`client=${client.name}/${client.version ?? "?"}`)
      }
      // 2026-07-28 requests carry their protocol version in a per-request _meta envelope.
      const envelopeVersion = msg.params?._meta?.["io.modelcontextprotocol/protocolVersion"]
      if (typeof envelopeVersion === "string") parts.push(`meta=${envelopeVersion}`)
      if (msg.id !== undefined) parts.push(`id=${msg.id}`)
      return parts.join(" ")
    }
    const summary = messages.map(describe).join(" | ")

    // Capture the response body (JSON, small) to report JSON-RPC errors and the negotiated version.
    const chunks: Buffer[] = []
    let size = 0
    const limit = 64 * 1024
    const capture = (chunk: unknown, encoding?: unknown) => {
      if (chunk === undefined || chunk === null || typeof chunk === "function" || size > limit)
        return
      // The SDK's Node adapter writes Uint8Array chunks; String() on those is not the body.
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : Buffer.from(
              String(chunk),
              typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8",
            )
      size += buf.length
      chunks.push(buf)
    }
    const originalWrite = res.write.bind(res) as (...args: any[]) => boolean
    const originalEnd = res.end.bind(res) as (...args: any[]) => Response
    res.write = ((...args: any[]) => {
      capture(args[0], args[1])
      return originalWrite(...args)
    }) as typeof res.write
    res.end = ((...args: any[]) => {
      capture(args[0], args[1])
      return originalEnd(...args)
    }) as typeof res.end

    res.on("finish", () => {
      const details: string[] = []
      if (size > 0 && size <= limit) {
        try {
          const body = Buffer.concat(chunks).toString("utf8")
          // 2025-era requests are answered as an SSE stream; parse its data lines.
          const payloads = /^(event|data|id|retry):/m.test(body.trimStart().slice(0, 16))
            ? body
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => JSON.parse(line.slice(5)))
            : [JSON.parse(body)]
          const parsed = payloads.flat()
          for (const msg of parsed) {
            if (msg?.error) {
              details.push(
                `error=${msg.error.code} ${JSON.stringify(String(msg.error.message ?? ""))}`,
              )
            }
            if (msg?.result?.protocolVersion) {
              details.push(`negotiated=${msg.result.protocolVersion}`)
            }
            if (msg?.result?.isError) details.push("toolError")
          }
        } catch {
          details.push("non-json response")
        }
      }
      console.error(
        `[MCP] ${summary} hdr=${headerVersion ?? "-"} -> ${res.statusCode}` +
          (details.length ? ` ${details.join(" ")}` : ""),
      )
    })
  }

  /**
   * Start the HTTP server
   *
   * @returns Promise that resolves when the server is started
   */
  public async start(): Promise<void> {
    // Load resources based on available tokens

    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        console.error(`MCP StreamableHTTP server running on http://${this.host}:${this.port}/mcp`)
        resolve()
      })

      // Handle server errors
      this.server.on("error", (err: Error) => {
        console.error(`Server error: ${err.message}`)
      })
    })
  }

  /**
   * Stop the HTTP server
   *
   * @returns Promise that resolves when the server is stopped
   */
  public async stop(): Promise<void> {
    console.error("Stopping HTTP server...")

    // Abort modern exchanges still in flight and close their per-request servers
    try {
      await this.mcpHandler.close()
    } catch (error) {
      ErrorUtils.logError(error, "MCP Handler Shutdown")
    }

    // Clean up rate limiter
    if (this.rateLimiter) {
      this.rateLimiter.limiter.destroy()
    }

    // Close the HTTP server
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Server shutdown timed out"))
        }, 10000) // 10 second timeout

        this.server.close((err?: Error) => {
          clearTimeout(timeout)
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      })
    }

    console.error("HTTP server stopped successfully")
  }
}
