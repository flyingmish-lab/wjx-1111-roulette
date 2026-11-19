const encoder = new TextEncoder();
export const SESSION_SECONDS = 3600;
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0"))
    .join("");

export async function digest(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function equalPassword(
  input: string,
  expected: string,
): Promise<boolean> {
  const a = await digest(input);
  const b = await digest(expected);
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

async function signingKey(password: string, secret: string) {
  if (password.length < 12 || secret.length < 32) {
    throw new Error("Admin configuration missing");
  }
  // A change of either secret invalidates all previously issued tokens.
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`wjx-admin-v1:${await digest(password)}`),
  );
  return crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function issueSession(
  password: string,
  secret: string,
  now = Date.now(),
) {
  const expires = Math.floor(now / 1000) + SESSION_SECONDS;
  const id = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const payload = `wjx1.${id}.${expires}`;
  const signature = hex(
    await crypto.subtle.sign(
      "HMAC",
      await signingKey(password, secret),
      encoder.encode(payload),
    ),
  );
  const token = `${payload}.${signature}`;
  return {
    token,
    tokenHash: await digest(token),
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}

export async function verifyToken(
  token: unknown,
  password: string,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  if (
    typeof token !== "string" ||
    !/^wjx1\.[a-f0-9]{64}\.[0-9]{10}\.[a-f0-9]{64}$/.test(token)
  ) return false;
  const parts = token.split(".");
  const expires = Number(parts[2]);
  const current = Math.floor(now / 1000);
  if (expires <= current || expires > current + SESSION_SECONDS) return false;
  const signature = Uint8Array.from(
    parts[3].match(/../g)!,
    (byte) => parseInt(byte, 16),
  );
  return crypto.subtle.verify(
    "HMAC",
    await signingKey(password, secret),
    signature,
    encoder.encode(parts.slice(0, 3).join(".")),
  );
}

export async function requireAdmin(
  req: Request,
  db: any,
  password: string,
  secret: string,
): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!(await verifyToken(token, password, secret))) return null;
  const hash = await digest(token);
  const { data, error } = await db.from("wjx_admin_sessions")
    .select("expires_at").eq("token_hash", hash).maybeSingle();
  if (error) throw new Error("Session lookup failed");
  if (!data || Date.parse(data.expires_at) <= Date.now()) return null;
  return hash;
}
