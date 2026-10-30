// Thin client for the Familio JSON API. The session lives in an HttpOnly
// cookie the browser sends itself; no token or secret is ever held in script.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

/** XHR variant used when the caller wants upload progress (fetch has none). */
function apiWithProgress(method, path, body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, path);
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", "application/json");
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener("error", () => reject(new TypeError("network")));
    xhr.addEventListener("abort", () => reject(new TypeError("network")));
    xhr.addEventListener("load", () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // Non-JSON body: leave data null.
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error || "error", data?.message));
    });
    xhr.send(JSON.stringify(body));
  });
}

export async function api(method, path, body, onProgress) {
  if (onProgress) return apiWithProgress(method, path, body, onProgress);
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
  unsupported_type: "Not a supported photo or video.",
  bad_file: "The file could not be read.",
  forbidden: "Only an Admin can do that.",
  cannot_remove_self: "You cannot remove yourself.",
  member_not_found: "That Member no longer exists.",
  confirmation_required: "Please confirm before deleting a Library.",
  import_not_configured: "Server Import is not configured on this server.",
  import_folder_not_found: "The import folder was not found.",
  backup_failed: "The backup failed.",
  payload_too_large: "This file is too large to upload.",
};

export function describeError(err) {
  if (err instanceof ApiError) return MESSAGES[err.code] || err.message || "Something went wrong.";
  return "Could not reach the server.";
}
