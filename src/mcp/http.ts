import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createBearerAuth, type AuthFailureReason } from './auth';
import { MODERN_PROTOCOL_VERSION, SDK_PROTOCOL_VERSION } from './modernProtocol';

/** 바인드 주소는 루프백 고정이다. 0.0.0.0 금지 (project.md §5.2). */
const BIND_ADDRESS = '127.0.0.1';
const BODY_LIMIT = '5mb';
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 120;

export const MCP_ENDPOINT = '/mcp';

export interface HttpLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface HttpServerOptions {
  readonly port: number;
  readonly getToken: () => string | undefined;
  /** 요청마다 새 McpServer를 만든다. 아래 무상태 모드 설명 참조. */
  readonly createServer: () => McpServer;
  readonly log: HttpLogger;
  readonly onAuthFailure?: (reason: AuthFailureReason, remoteAddress: string | undefined) => void;
}

export class PortInUseError extends Error {
  constructor(readonly port: number) {
    super(`Port ${port} is already in use`);
    this.name = 'PortInUseError';
  }
}

/**
 * MCP Streamable HTTP 서버.
 *
 * vscode 모듈에 의존하지 않는다. 인증·바인딩·레이트리밋을 확장 호스트 없이
 * 그대로 테스트하기 위해서다.
 *
 * 무상태(stateless) 모드를 쓴다. 요청마다 McpServer와 transport를 새로 만들고
 * 응답이 끝나면 정리한다. 세션 맵을 들고 있지 않으므로 커넥터가 세션을 끊거나
 * 재연결해도 서버 쪽에 찌꺼기가 남지 않는다. 툴 등록 비용은 무시할 수준이다.
 */
export class McpHttpServer {
  private server: Server | undefined;
  private boundPort: number | undefined;

  constructor(private readonly options: HttpServerOptions) {}

  get port(): number | undefined {
    return this.boundPort;
  }

  get isRunning(): boolean {
    return this.server !== undefined;
  }

  async start(): Promise<number> {
    if (this.server !== undefined) {
      throw new Error('The server is already running');
    }

    const app = express();

    // CORS는 붙이지 않는다. 브라우저에서 직접 부를 일이 없다.
    app.disable('x-powered-by');
    app.use(express.json({ limit: BODY_LIMIT }));
    app.use(
      rateLimit({
        windowMs: RATE_WINDOW_MS,
        limit: RATE_LIMIT,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { jsonrpc: '2.0', error: { code: -32029, message: 'Too many requests' }, id: null }
      })
    );

    const auth = createBearerAuth({
      getToken: this.options.getToken,
      ...(this.options.onAuthFailure !== undefined ? { onFailure: this.options.onAuthFailure } : {})
    });

    // 헬스체크는 인증 없이 열어 둔다. 상태 문자열 외에는 아무것도 반환하지 않는다.
    app.get('/health', (_req, res) => {
      res.json({ status: 'ok' });
    });

    app.post(MCP_ENDPOINT, auth, (req, res) => {
      void this.handleMcpPost(req.body, req, res);
    });

    // 무상태 모드에는 서버 주도 스트림도 세션 종료도 없다.
    app.get(MCP_ENDPOINT, auth, (_req, res) => {
      res.status(405).set('Allow', 'POST').json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method Not Allowed: this server runs in stateless mode' },
        id: null
      });
    });
    app.delete(MCP_ENDPOINT, auth, (_req, res) => {
      res.status(405).set('Allow', 'POST').json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method Not Allowed: this server runs in stateless mode' },
        id: null
      });
    });

    return new Promise<number>((resolve, reject) => {
      const server = app.listen(this.options.port, BIND_ADDRESS);

      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        if (error.code === 'EADDRINUSE') {
          reject(new PortInUseError(this.options.port));
          return;
        }
        reject(error);
      };

      const onListening = (): void => {
        server.removeListener('error', onError);
        const address = server.address() as AddressInfo | null;
        this.server = server;
        this.boundPort = address?.port ?? this.options.port;
        this.options.log.info(`MCP server listening at http://${BIND_ADDRESS}:${this.boundPort}${MCP_ENDPOINT}`);
        resolve(this.boundPort);
      };

      server.once('error', onError);
      server.once('listening', onListening);
    });
  }

  private async handleMcpPost(
    body: unknown,
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    // The installed MCP SDK validates transport headers before dispatching.
    // Modern requests are self-contained in params._meta, so let the isolated
    // compatibility layer handle them while presenting the newest SDK version
    // the transport itself understands.
    if (req.header('mcp-protocol-version') === MODERN_PROTOCOL_VERSION) {
      req.headers['mcp-protocol-version'] = SDK_PROTOCOL_VERSION;
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        if (req.rawHeaders[index]?.toLowerCase() === 'mcp-protocol-version') {
          req.rawHeaders[index + 1] = SDK_PROTOCOL_VERSION;
        }
      }
    }

    const server = this.options.createServer();
    // sessionIdGenerator를 주지 않으면 무상태 모드가 된다.
    // SDK는 무상태에서 transport 재사용을 거부하므로 요청마다 새로 만든다.
    const transport = new StreamableHTTPServerTransport({});

    // 응답이 끝나면 반드시 정리한다. 누락되면 요청마다 리소스가 쌓인다.
    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.log.error(`Failed to handle MCP request: ${reason}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) {
      return;
    }
    this.server = undefined;
    this.boundPort = undefined;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // keep-alive 연결이 남아 있으면 close가 늦어진다. 즉시 끊는다.
      server.closeAllConnections();
    });
    this.options.log.info('MCP server stopped');
  }
}
