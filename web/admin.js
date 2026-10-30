// Admin screens: Members, invitations, backups, disk usage, Server Import.
import { api, describeError } from "./api.js";
import { el } from "./dom.js";

const MB = 1024 * 1024;
function formatBytes(n) {
  if (n >= 1024 * MB) return `${(n / (1024 * MB)).toFixed(1)} GB`;
  return `${(n / MB).toFixed(1)} MB`;
}

function message() {
  return el("p", { class: "msg", role: "alert" });
}
function say(msg, text, kind) {
  msg.className = kind ? `msg ${kind}` : "msg";
  msg.textContent = text;
}

/** Run an async action behind a button, reporting the outcome in `msg`. */
async function guarded(button, msg, action) {
  button.disabled = true;
  say(msg, "");
  try {
    await action();
  } catch (err) {
    say(msg, describeError(err), "error");
  } finally {
    button.disabled = false;
  }
}

function membersPanel(me) {
  const list = el("ul", { class: "rows" });
  const msg = message();
  const panel = el("section", { class: "card wide" }, el("h2", {}, "Members"), list, msg);

  async function load() {
    const { members } = await api("GET", "/api/members");
    list.replaceChildren(...members.map(row));
  }

  function row(m) {
    const li = el("li", {}, el("span", {}, `${m.email} `, el("span", { class: "muted" }, m.role)));
    if (m.id === me.id) return li;
    const choice = el(
      "select",
      { "aria-label": `What happens to ${m.email}'s private Library` },
      el("option", { value: "keep" }, "Keep their private Library"),
      el("option", { value: "transfer" }, "Transfer it to the Family Library"),
      el("option", { value: "delete" }, "Delete it"),
    );
    const remove = el("button", { type: "button" }, "Remove");
    remove.addEventListener("click", () =>
      guarded(remove, msg, async () => {
        const action = choice.value;
        const warning = action === "delete"
          ? `Remove ${m.email} and permanently delete their private Library?`
          : `Remove ${m.email}?`;
        if (!confirm(warning)) return;
        await api("POST", `/api/members/${m.id}/remove`, { action, confirm: action === "delete" });
        say(msg, `${m.email} was removed.`, "ok");
        await load();
      }),
    );
    li.append(choice, remove);
    return li;
  }

  load().catch((err) => say(msg, describeError(err), "error"));
  return panel;
}

function invitePanel() {
  const msg = message();
  const link = el("input", { readonly: "", "aria-label": "Invitation link", hidden: "" });
  const button = el("button", { class: "primary", type: "submit" }, "Invite");
  const form = el(
    "form",
    {},
    el("label", {}, "Email", el("input", { name: "email", type: "email", required: "" })),
    el(
      "label",
      {},
      "Role",
      el("select", { name: "role" }, el("option", { value: "member" }, "Member"), el("option", { value: "admin" }, "Admin")),
    ),
    button,
    msg,
    link,
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    guarded(button, msg, async () => {
      const inv = await api("POST", "/api/invitations", Object.fromEntries(new FormData(form)));
      link.value = `${location.origin}/invite?token=${encodeURIComponent(inv.token)}`;
      link.hidden = false;
      say(msg, `Invitation created for ${inv.email}. Send them this link:`, "ok");
      form.reset();
    });
  });
  return el("section", { class: "card wide" }, el("h2", {}, "Invite a Member"), form);
}

function backupPanel() {
  const status = el("p", {});
  const msg = message();
  const run = el("button", { type: "button" }, "Run backup now");
  const panel = el("section", { class: "card wide" }, el("h2", {}, "Backups"), status, run, msg);

  function show(s) {
    if (!s.configured) {
      status.textContent = "Backup storage is not configured.";
      run.disabled = true;
      return;
    }
    const last = s.lastRun;
    status.textContent = last
      ? `Last backup: ${last.status} at ${new Date(last.startedAt).toLocaleString()}` +
        (last.error ? ` (${last.error})` : last.byteSize != null ? `, ${formatBytes(last.byteSize)}` : "")
      : "No backup has run yet.";
  }

  const load = async () => show(await api("GET", "/api/admin/backups"));
  run.addEventListener("click", () =>
    guarded(run, msg, async () => {
      await api("POST", "/api/admin/backups", {});
      say(msg, "Backup finished.", "ok");
      await load();
    }),
  );
  load().catch((err) => say(msg, describeError(err), "error"));
  return panel;
}

function diskPanel() {
  const text = el("p", {});
  const bar = el("progress", { max: "1", value: "0", "aria-label": "Disk used" });
  const msg = message();
  api("GET", "/api/admin/disk")
    .then((d) => {
      bar.value = d.totalBytes ? d.usedBytes / d.totalBytes : 0;
      text.textContent = `${formatBytes(d.usedBytes)} used of ${formatBytes(d.totalBytes)}; ${formatBytes(d.availableBytes)} available.`;
    })
    .catch((err) => say(msg, describeError(err), "error"));
  return el("section", { class: "card wide" }, el("h2", {}, "Disk usage"), bar, text, msg);
}

function importPanel(libraries) {
  const msg = message();
  const target = el("select", { name: "libraryId" });
  for (const lib of libraries) {
    target.append(el("option", { value: String(lib.id) }, lib.kind === "family" ? "Family Library" : `Private Library #${lib.id}`));
  }
  const button = el("button", { class: "primary", type: "submit" }, "Start import");
  const form = el("form", {}, el("label", {}, "Import into", target), button, msg);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    guarded(button, msg, async () => {
      say(msg, "Importing…");
      const r = await api("POST", "/api/admin/import", { libraryId: Number(target.value) });
      say(msg, `Imported ${r.importedCount}, skipped ${r.skippedCount}, unsupported ${r.unsupportedCount}, failed ${r.failedCount}.`, "ok");
    });
  });
  return el("section", { class: "card wide" }, el("h2", {}, "Server Import"), form);
}

/** The Admin screen; only reachable for Admins (the server enforces it too). */
export function adminScreen({ me, libraries }) {
  return el(
    "div",
    { class: "admin" },
    membersPanel(me),
    invitePanel(),
    backupPanel(),
    diskPanel(),
    importPanel(libraries),
  );
}
