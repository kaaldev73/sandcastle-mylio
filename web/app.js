// App shell: path-based routing, session check, Library switcher.
import { api, ApiError } from "./api.js";
import { el } from "./dom.js";
import { browse } from "./browse.js";
import { uploader } from "./upload.js";
import { inviteScreen, resetScreen, setupScreen, signInScreen } from "./auth.js";

const root = document.getElementById("app");
const LIBRARY_KEY = "familio.library";
let member = null;

function go(href) {
  history.pushState({}, "", href);
  render();
}
window.addEventListener("popstate", render);

function signedIn(m) {
  member = m;
  go("/");
}

function mount(...nodes) {
  root.replaceChildren(...nodes);
}

function libraryLabel(lib) {
  return lib.kind === "family" ? "Family Library" : "My private Library";
}

function shell(libraries) {
  const saved = Number(localStorage.getItem(LIBRARY_KEY));
  let current = libraries.find((l) => l.id === saved) || libraries.find((l) => l.kind === "private") || libraries[0];

  const select = document.createElement("select");
  select.setAttribute("aria-label", "Library");
  for (const lib of libraries) {
    const opt = document.createElement("option");
    opt.value = String(lib.id);
    opt.textContent = libraryLabel(lib);
    opt.selected = lib.id === current?.id;
    select.append(opt);
  }

  const signOut = document.createElement("button");
  signOut.textContent = "Sign out";
  signOut.addEventListener("click", async () => {
    try {
      await api("POST", "/api/logout", {});
    } finally {
      member = null;
      go("/signin");
    }
  });

  const brand = document.createElement("span");
  brand.className = "brand";
  brand.textContent = "Familio";
  const bar = document.createElement("header");
  bar.className = "topbar";
  bar.append(brand, select, signOut);

  const main = document.createElement("main");
  const heading = document.createElement("h1");
  const content = document.createElement("div");
  const uploadHost = document.createElement("div");
  main.append(heading, uploadHost, content);

  const show = () => {
    heading.textContent = current ? libraryLabel(current) : "No Library";
    if (current) localStorage.setItem(LIBRARY_KEY, String(current.id));
    if (current) {
      uploadHost.replaceChildren(uploader(current, () => browse(content, current)));
      browse(content, current);
    } else {
      uploadHost.replaceChildren();
      content.replaceChildren();
    }
  };
  select.addEventListener("change", () => {
    current = libraries.find((l) => l.id === Number(select.value));
    show();
  });
  show();
  mount(bar, main);
}

async function render() {
  const url = new URL(location.href);
  const token = url.searchParams.get("token") || "";
  const ctx = { go, signedIn };

  if (!member) {
    try {
      member = await api("GET", "/api/me");
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) {
        mount(el("p", { class: "center muted" }, "Could not reach the server."));
        return;
      }
    }
  }

  if (!member) {
    switch (url.pathname) {
      case "/setup": return mount(setupScreen(ctx));
      case "/invite": return mount(inviteScreen({ ...ctx, token }));
      case "/reset": return mount(resetScreen({ ...ctx, token }));
      default:
        if (url.pathname !== "/signin") history.replaceState({}, "", "/signin");
        return mount(signInScreen(ctx));
    }
  }

  if (url.pathname !== "/") history.replaceState({}, "", "/");
  const { libraries } = await api("GET", "/api/libraries");
  shell(libraries);
}

render();
