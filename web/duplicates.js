// Duplicates: sets of byte-identical Assets in one Library, side by side, with
// the suggested keeper preselected. Resolving keeps one and sends the rest to Trash.
import { api, describeError } from "./api.js";
import { el } from "./dom.js";

/** Mount the Duplicates screen for one Library into `host`. */
export function duplicatesScreen(host, library) {
  const status = el("p", { class: "msg", role: "status" });
  const list = el("div", { class: "dup-list" });
  host.replaceChildren(status, list);

  const say = (text, kind) => {
    status.className = kind ? "msg " + kind : "msg";
    status.textContent = text;
  };

  async function load() {
    let data;
    try {
      data = await api("GET", "/api/libraries/" + library.id + "/duplicates");
    } catch (err) {
      return say(describeError(err), "error");
    }
    list.replaceChildren(
      ...(data.sets.length
        ? data.sets.map(card)
        : [el("p", { class: "muted" }, "No Duplicates in this Library.")]),
    );
  }

  function card(set) {
    const group = "keeper-" + set.contentHash;
    const choices = set.assets.map((a) => {
      const radio = el("input", { type: "radio", name: group, value: String(a.id) });
      radio.checked = a.id === set.suggestedKeeperId;
      return { asset: a, radio };
    });
    const resolve = el("button", {
      class: "primary",
      onclick: async () => {
        const keeper = choices.find((c) => c.radio.checked).asset;
        const others = set.assets.length - 1;
        if (!confirm(
          "Keep " + keeper.filename + "? The other " + (others === 1 ? "copy goes" : others + " copies go") +
          " to Trash, where you can restore " + (others === 1 ? "it" : "them") +
          ". Their Ratings and Albums are merged into the one you keep.",
        )) return;
        try {
          await api("POST", "/api/libraries/" + library.id + "/duplicates/resolve", {
            keeperId: keeper.id,
            confirm: true,
          });
        } catch (err) {
          return say(describeError(err), "error");
        }
        say("Kept " + keeper.filename + ". The other copies are in Trash.", "ok");
        await load();
      },
    }, "Keep selected");
    return el("section", { class: "card dup-set" },
      el("div", { class: "dup-assets" }, ...choices.map(({ asset: a, radio }) =>
        el("label", { class: "dup-asset" },
          el("img", { src: a.thumbnailUrl, alt: a.filename, loading: "lazy" }),
          el("span", {}, radio, " " + a.filename + (a.id === set.suggestedKeeperId ? " (suggested)" : "")),
          el("span", { class: "muted" },
            new Date(a.captureDate).toLocaleDateString() +
            (a.stars ? " · " + "★".repeat(a.stars) : "") +
            (a.albumCount ? " · in " + a.albumCount + (a.albumCount === 1 ? " Album" : " Albums") : "")),
        ))),
      resolve,
    );
  }

  return load();
}
