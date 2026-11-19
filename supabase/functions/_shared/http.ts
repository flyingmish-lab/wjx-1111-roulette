export const corsHeaders = {
  "Access-Control-Allow-Origin": "https://flyingmish-lab.github.io",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function json(body: unknown, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: { ...corsHeaders, ...headers },
  });
}

export function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }
  const origin = req.headers.get("origin");
  if (origin && origin !== corsHeaders["Access-Control-Allow-Origin"]) {
    return json({ success: false, error: "Origin not allowed" }, 403);
  }
  return null;
}

export async function readBody(req: Request): Promise<Record<string, any>> {
  if (
    !req.headers.get("content-type")?.toLowerCase().startsWith(
      "application/json",
    )
  ) {
    throw new RequestError(415, "JSON required");
  }
  const reader = req.body?.getReader();
  if (!reader) throw new RequestError(400, "Invalid JSON");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 16384) {
      await reader.cancel();
      throw new RequestError(413, "Request too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RequestError(400, "Invalid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError(400, "Invalid JSON object");
  }
  return body;
}

export class RequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function failure(error: unknown): Response {
  if (error instanceof RequestError) {
    return json({ success: false, error: error.message }, error.status);
  }
  // Never log credentials, request bodies, tokens or database errors containing user data.
  return json({ success: false, error: "Сервис временно недоступен" }, 503);
}
