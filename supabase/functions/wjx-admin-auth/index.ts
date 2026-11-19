import { createClient } from "npm:@supabase/supabase-js@2.119.2";
import { failure, json, preflight, readBody } from "../_shared/http.ts";
import {
  equalPassword,
  issueSession,
  requireAdmin,
} from "../_shared/admin-session.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  {
    auth: { persistSession: false, autoRefreshToken: false },
  },
);

export async function handleAdminAuth(req: Request): Promise<Response> {
  try {
    const early = preflight(req);
    if (early) return early;
    const body = await readBody(req);
    const password = Deno.env.get("WJX_ADMIN_PASSWORD") ?? "";
    const secret = Deno.env.get("WJX_ADMIN_SESSION_SECRET") ?? "";
    if (password.length < 12 || secret.length < 32) {
      throw new Error("Admin configuration missing");
    }

    if (body.action === "logout") {
      const hash = await requireAdmin(req, db, password, secret);
      if (!hash) {
        return json(
          { success: false, error: "Сессия истекла. Войдите снова." },
          401,
        );
      }
      const { error } = await db.from("wjx_admin_sessions").delete().eq(
        "token_hash",
        hash,
      );
      if (error) throw new Error("Logout failed");
      return json({ success: true });
    }
    if (body.action !== "login") {
      return json({ success: false, error: "Unknown action" }, 400);
    }

    // Reserve attempts atomically BEFORE comparing passwords, including malformed attempts.
    // Global account throttle intentionally does not trust browser-supplied IP headers.
    const { data, error } = await db.rpc("wjx_consume_admin_login_attempt");
    if (error || !data?.[0]) throw new Error("Rate limiter unavailable");
    if (!data[0].allowed) {
      return json(
        {
          success: false,
          error: "Слишком много попыток входа. Попробуйте позже.",
        },
        429,
        { "Retry-After": String(data[0].retry_after) },
      );
    }
    if (
      typeof body.password !== "string" || body.password.length === 0 ||
      body.password.length > 256 ||
      !(await equalPassword(body.password, password))
    ) {
      return json({ success: false, error: "Неверный пароль" }, 401);
    }
    const session = await issueSession(password, secret);
    const { error: sessionError } = await db.from("wjx_admin_sessions").insert({
      token_hash: session.tokenHash,
      expires_at: session.expiresAt,
    });
    if (sessionError) throw new Error("Session creation failed");
    return json({
      success: true,
      token: session.token,
      expires_at: session.expiresAt,
    });
  } catch (error) {
    return failure(error);
  }
}

Deno.serve(handleAdminAuth);
