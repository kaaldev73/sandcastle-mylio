// Albums: list, create, rename, delete, and a paged Album view where Assets
// can be removed. Adding Assets happens from the Asset viewer (browse.js).
import { api, describeError } from "./api.js";
import { el } from "./dom.js";

const PAGE_SIZE = 60;

/** Mount the Albums screen for one Library into `host`. */
export function albumsScreen(host, library) {
  const status = el("p", { class: "msg", role: "status" });
  const body = el("div", { class: "albums-body" });
  host.replaceChildren(status, body);

  const fail = (err) => {
    status.className = "msg error";
    status.textContent = describeError(err);
  };
  const clear = () => {
    status.className = "msg";
    status.textContent = "";
  };

  async function showList() {
    let data;
    try {
      data = await api("GET", "/api/libraries/" + library.id + "/albums");
    } catch (err) {
      return fail(err);
    }
    clear();
    const name = el("input", { placeholder: "New Album name", "aria-label": "New Album name" });
    const create = el("button", {
      class: "primary",
      onclick: async () => {
        if (!name.value.trim()) return;
        try {
          const album = await api("POST", "/api/libraries/" + library.id + "/albums", { name: name.value.trim() });
          showAlbum(album.id);
        } catch (err) {
          fail(err);
        }
      },
    }, "Create");
    const rows = data.albums.map((a) =>
      el("button", { class: "album-row", onclick: () => showAlbum(a.id) },
        el("span", {}, a.name),
        el("span", { class: "muted" }, a.assetCount + (a.assetCount === 1 ? " photo" : " photos"))),
    );
    body.replaceChildren(
      el("div", { class: "album-new" }, name, create),
      rows.length ? el("div", { class: "album-list" }, ...rows) : el("p", { class: "muted" }, "No Albums yet."),
    );
  }

  async function showAlbum(id) {
    let album;
    try {
      album = await api("GET", "/api/albums/" + id);
    } catch (err) {
      return fail(err);
    }
    clear();
    draw(album);
  }

  function draw(album) {
    let shown = PAGE_SIZE;
    const title = el("h2", {}, album.name);
    const rename = el("button", {
      onclick: async () => {
        const next = prompt("Album name", album.name);
        if (!next || !next.trim()) return;
        try {
          draw(await api("PATCH", "/api/albums/" + album.id, { name: next.trim() }));
        } catch (err) {
          fail(err);
        }
      },
    }, "Rename");
    const del = el("button", {
      onclick: async () => {
        if (!confirm('Delete Album "' + album.name + '"? Its photos stay in the Library.')) return;
        try {
          await api("DELETE", "/api/albums/" + album.id);
          showList();
        } catch (err) {
          fail(err);
        }
      },
    }, "Delete Album");
    const back = el("button", { class: "link", onclick: showList }, "‹ Albums");
    const grid = el("div", { class: "grid" });
    const more = el("button", { class: "primary", hidden: "" }, "Load more");
    const count = el("p", { class: "muted" }, album.assets.length + (album.assets.length === 1 ? " photo" : " photos"));

    const drawGrid = () => {
      grid.replaceChildren(...album.assets.slice(0, shown).map((a, i) =>
        el("div", { class: "album-tile" },
          el("button", { class: "tile", "aria-label": "Open " + a.filename, onclick: () => view(i) },
            el("img", { src: a.thumbnailUrl, alt: a.filename, loading: "lazy" })),
          el("button", {
            class: "remove", "aria-label": "Remove " + a.filename + " from Album",
            onclick: () => removeAsset(a.id),
          }, "×")),
      ));
      more.hidden = shown >= album.assets.length;
    };
    more.addEventListener("click", () => { shown += PAGE_SIZE; drawGrid(); });

    async function removeAsset(assetId) {
      try {
        album = await api("DELETE", "/api/albums/" + album.id + "/assets/" + assetId);
        clear();
        draw(album);
      } catch (err) {
        fail(err);
      }
    }

    function view(i) {
      const a = album.assets[i];
      const overlay = el("div", { class: "viewer" });
      const img = el("img", { src: a.originalUrl, alt: a.filename });
      img.addEventListener("error", () => { if (img.src.indexOf("thumbnail") < 0) img.src = a.thumbnailUrl; }, { once: true });
      const prev = el("button", { onclick: () => { overlay.remove(); view(i - 1); } }, "‹ Prev");
      const next = el("button", { onclick: () => { overlay.remove(); view(i + 1); } }, "Next ›");
      prev.disabled = i === 0;
      next.disabled = i === album.assets.length - 1;
      overlay.append(
        el("div", { class: "viewer-bar" }, prev,
          el("span", { class: "muted" }, a.filename + " · " + (i + 1) + " of " + album.assets.length),
          next, el("button", { onclick: () => overlay.remove() }, "Close")),
        el("div", { class: "viewer-stage" }, img),
        el("div", { class: "rating-bar" },
          el("button", { onclick: () => { overlay.remove(); removeAsset(a.id); } }, "Remove from Album")),
      );
      host.append(overlay);
    }

    drawGrid();
    body.replaceChildren(
      back, title, el("div", { class: "album-actions" }, rename, del), count, grid, more,
    );
  }

  return showList();
}

/** Controls for the Asset viewer: add the open Asset to one of the Library's Albums. */
export function addToAlbumControls(library, assetId, onMessage) {
  const select = el("select", { "aria-label": "Album" });
  const add = el("button", { disabled: "" }, "Add to Album");
  const wrap = el("span", { class: "album-add" }, select, add);
  api("GET", "/api/libraries/" + library.id + "/albums").then(
    (data) => {
      if (!data.albums.length) {
        wrap.hidden = true;
        return;
      }
      for (const a of data.albums) select.append(el("option", { value: String(a.id) }, a.name));
      add.disabled = false;
    },
    () => { wrap.hidden = true; },
  );
  add.addEventListener("click", async () => {
    try {
      await api("POST", "/api/albums/" + select.value + "/assets", { assetId });
      onMessage("Added to " + select.selectedOptions[0].textContent + ".");
    } catch (err) {
      onMessage(describeError(err), true);
    }
  });
  return wrap;
}
