// Thin client for the Familio JSON API. The session lives in an HttpOnly
// cookie the browser sends itself; no token or secret is ever held in script.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export async function api(method, path, body) {
  const init = { method, headers: {}, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body: leave data null.
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || "error", data?.message);
  return data;
}

const MESSAGES = {
  invalid_credentials: "Wrong email or password.",
  too_many_attempts: "Too many attempts. Wait a few minutes and try again.",
  weak_password: "Choose a longer password.",
  already_initialised: "This server is already set up. Sign in instead.",
  invalid_invitation: "This invitation link is not valid.",
  invitation_already_used: "This invitation has already been used.",
  invitation_expired: "This invitation has expired. Ask for a new one.",
  already_member: "That email already has an account.",
  invalid_reset: "This reset link is not valid.",
  unauthenticated: "Please sign in.",
};

export function describeError(err) {
  if (err instanceof ApiError) return MESSAGES[err.code] || err.message || "Something went wrong.";
  return "Could not reach the server.";
}
