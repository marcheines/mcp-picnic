import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js"
import express, { Request, Response, NextFunction } from "express"
import cors from "cors"
import { BaseTransportServer } from "./base.js"
import type { createMCPServer } from "../utils/server-factory.js"
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
  private activeRequests = new Set<{
    transport: StreamableHTTPServerTransport
    server: ReturnType<typeof createMCPServer>
  }>()

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
    // MCP endpoint. The server is stateless: every POST is handled on its own, so there are
    // no sessions that can expire, get lost on a redeploy, or be missing from a request.
    this.app.post("/mcp", async (req: Request, res: Response) => {
      try {
        await this.handlePostRequest(req, res)
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

    // Without sessions there is no server-initiated SSE stream (GET) and nothing to terminate
    // (DELETE). The MCP spec has servers answer both with 405, which clients handle gracefully.
    this.app.all("/mcp", (_req: Request, res: Response) => {
      res.setHeader("Allow", "POST")
      res.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed: this server is stateless" },
        id: null,
      })
    })

    // Add a health check endpoint
    this.app.get("/health", (_req: Request, res: Response) => {
      try {
        const stats = this.rateLimiter?.limiter.getStats()
        res.status(200).json({
          status: "ok",
          timestamp: new Date().toISOString(),
          mode: "stateless",
          activeRequests: this.activeRequests.size,
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
   * Handle one MCP POST request with a fresh server and transport.
   *
   * Stateful sessions broke the connector: Claude's connector proxy runs on several workers and
   * sometimes sent requests without a session id (400), and sessions vanished after 30 minutes
   * idle or on every redeploy (404). Each failure made the client mark the server disconnected.
   * The Picnic client and its login are process-wide, so nothing per-connection is lost.
   */
  private async handlePostRequest(req: Request, res: Response): Promise<void> {
    this.dropUnsupportedProtocolVersion(req)

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    // Log why the SDK rejects a request; the access log alone only shows the status code.
    transport.onerror = (error: Error) => {
      const method = Array.isArray(req.body) ? "batch" : (req.body?.method ?? "unknown")
      console.error(`[MCP transport] ${method}: ${error.message}`)
    }
    const server = this.createConfiguredServer()
    const entry = { transport, server }
    this.activeRequests.add(entry)

    res.on("close", () => {
      this.activeRequests.delete(entry)
      void this.closeQuietly(transport, server)
    })

    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  }

  /**
   * Remove an MCP-Protocol-Version header this SDK does not know.
   *
   * The SDK answers such requests with 400, which makes Claude mark the connector disconnected.
   * A client on a newer protocol revision than the SDK still talks a compatible subset, and a
   * stateless server has no negotiated version to protect, so the SDK default is used instead.
   */
  private dropUnsupportedProtocolVersion(req: Request): void {
    const version = req.headers["mcp-protocol-version"]
    if (typeof version !== "string" || SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
      return
    }
    console.error(`[MCP transport] ignoring unsupported MCP-Protocol-Version: ${version}`)
    delete req.headers["mcp-protocol-version"]
    const raw = req.rawHeaders
    for (let i = raw.length - 2; i >= 0; i -= 2) {
      if (raw[i].toLowerCase() === "mcp-protocol-version") {
        raw.splice(i, 2)
      }
    }
  }

  /**
   * Close a request's transport and server, ignoring errors (the response is already done).
   */
  private async closeQuietly(
    transport: StreamableHTTPServerTransport,
    server: ReturnType<typeof createMCPServer>,
  ): Promise<void> {
    try {
      await transport.close()
      await server.close()
    } catch (error) {
      ErrorUtils.logError(error, "MCP Request Cleanup")
    }
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

    // Close the transports of requests still in flight
    const inFlight = [...this.activeRequests]
    this.activeRequests.clear()
    await Promise.allSettled(
      inFlight.map(({ transport, server }) => this.closeQuietly(transport, server)),
    )

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
