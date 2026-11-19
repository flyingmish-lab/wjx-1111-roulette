import { json } from "../_shared/http.ts";

// Retire the previously deployed password oracle. Never compare a password here.
export function retiredAuth(): Response {
  return json({ success: false, error: "Endpoint retired" }, 410);
}
Deno.serve(retiredAuth);
