// Minimal ambient types for the Cloudflare runtime APIs this app uses. The full @cloudflare/workers-types package
// redefines DOM globals (Request, Response, ReadableStream) and conflicts with the React portals' DOM types.

declare module "cloudflare:workers" {
  export const env: Record<string, unknown> & { DB?: D1Database; MEDIA?: R2Bucket };
}

interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: { changes: number; [key: string]: unknown };
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<unknown>;
}

interface R2ObjectBody {
  body: ReadableStream;
  httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | Blob | string | null, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}
