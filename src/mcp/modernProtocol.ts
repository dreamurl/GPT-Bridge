import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const MODERN_PROTOCOL_VERSION = '2026-07-28';
export const SDK_PROTOCOL_VERSION = '2025-11-25';

const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo';

type JsonRecord = Record<string, unknown>;
type RequestHandler = (request: JsonRecord, extra: unknown) => unknown | Promise<unknown>;

interface ProtocolInternals {
  readonly _requestHandlers?: unknown;
  fallbackRequestHandler?: RequestHandler;
}

export interface ModernProtocolOptions {
  readonly serverName: string;
  readonly serverVersion: string;
  readonly instructions: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isModernRequest(request: JsonRecord): boolean {
  if (!isRecord(request.params) || !isRecord(request.params._meta)) {
    return false;
  }
  return request.params._meta[PROTOCOL_VERSION_META] === MODERN_PROTOCOL_VERSION;
}

function annotateModernResult(result: unknown, options: ModernProtocolOptions): unknown {
  if (!isRecord(result)) {
    return result;
  }
  const existingMeta = isRecord(result._meta) ? result._meta : {};
  return {
    ...result,
    resultType: result.resultType ?? 'complete',
    _meta: {
      ...existingMeta,
      [SERVER_INFO_META]: {
        name: options.serverName,
        version: options.serverVersion
      }
    }
  };
}

/**
 * Add the sessionless protocol introduced in MCP 2026-07-28 without changing
 * the SDK's legacy initialize/session behavior.
 *
 * The TypeScript SDK currently tops out at 2025-11-25. Its public server API
 * does not expose a way to wrap every registered request handler, so this
 * compatibility shim is deliberately isolated around the protocol handler map.
 * Remove it once the SDK natively supports 2026-07-28.
 */
export function enableModernStatelessProtocol(
  server: McpServer,
  options: ModernProtocolOptions
): void {
  const protocol = server.server as unknown as ProtocolInternals;
  const requestHandlers = protocol._requestHandlers;
  if (!(requestHandlers instanceof Map)) {
    throw new Error('Unsupported MCP SDK: request handler registry is unavailable');
  }
  const typedRequestHandlers = requestHandlers as Map<string, RequestHandler>;

  for (const [method, handler] of typedRequestHandlers) {
    typedRequestHandlers.set(method, async (request, extra) => {
      const result = await handler(request, extra);
      return isModernRequest(request) ? annotateModernResult(result, options) : result;
    });
  }

  const previousFallback = protocol.fallbackRequestHandler;
  protocol.fallbackRequestHandler = async (request, extra) => {
    if (request.method === 'server/discover' && isModernRequest(request)) {
      return annotateModernResult(
        {
          ttlMs: 0,
          cacheScope: 'private',
          supportedVersions: [MODERN_PROTOCOL_VERSION],
          capabilities: { tools: { listChanged: true } },
          instructions: options.instructions
        },
        options
      );
    }

    if (previousFallback !== undefined) {
      return previousFallback(request, extra);
    }
    throw new McpError(ErrorCode.MethodNotFound, `Method not found: ${String(request.method)}`);
  };
}
