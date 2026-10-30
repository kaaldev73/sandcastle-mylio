// Trash: deleted Assets of one Library, newest deletion first, with Restore
// and permanent delete. Deleting itself happens in the Asset viewer (browse.js).
import { api, describeError } from "./api.js";
import { el, setStatus } from "./dom.js";

/** Mount the Trash screen for one Library into `host`. */
export function trashScreen(host, library) {
  const status = el("p", { class: "msg", role: "status" });
  const list = el("div", { class: "trash-list" });
  host.replaceChildren(status, list);

  const fail = (err) => setStatus(status, describeError(err), "error");

  async function load() {
    let data;
    try {
      data = await api("GET", "/api/libraries/" + library.id + "/deleted");
    } catch (err) {
      return fail(err);
    }
    setStatus(status);
    list.replaceChildren(
      ...(data.assets.length
        ? data.assets.map(row)
        : [el("p", { class: "muted" }, "Trash is empty.")]),
    );
  }

  /** Run one action on an Asset, then reload; a failure leaves the list as is. */
  async function act(call) {
    try {
      await call();
    } catch (err) {
      return fail(err);
    }
    await load();
  }

  function row(a) {
    return el("div", { class: "trash-row" },
      el("img", { src: a.thumbnailUrl, alt: a.filename, loading: "lazy" }),
      el("span", {},
        a.filename,
        el("span", { class: "muted" }, " · " + new Date(a.captureDate).toLocaleDateString())),
      el("button", {
        onclick: () => act(() => api("POST", "/api/assets/" + a.id + "/restore", {})),
      }, "Restore"),
      el("button", {
        class: "danger",
        onclick: () => {
          if (!confirm("Permanently delete " + a.filename + "? This cannot be undone.")) return;
          act(() => api("DELETE", "/api/assets/" + a.id + "/permanent", { confirm: true }));
        },
      }, "Delete permanently"),
    );
  }

  return load();
}
