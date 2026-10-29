// Account screens: first-Admin setup, sign-in, invite acceptance, password reset.
import { api, describeError } from "./api.js";
import { el } from "./dom.js";

function field(label, name, type, attrs = {}) {
  return el("label", {}, label, el("input", { name, type, required: "", ...attrs }));
}

/** Build a card with a form; `onSubmit(values)` resolves to finish or throws. */
function formCard({ title, intro, fields, submit, onSubmit, links = [] }) {
  const msg = el("p", { class: "msg", role: "alert" });
  const button = el("button", { class: "primary", type: "submit" }, submit);
  const form = el("form", {}, ...fields, button, msg);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.className = "msg";
    msg.textContent = "";
    button.disabled = true;
    try {
      await onSubmit(Object.fromEntries(new FormData(form)), msg);
    } catch (err) {
      msg.className = "msg error";
      msg.textContent = describeError(err);
    } finally {
      button.disabled = false;
    }
  });
  const nav = el("div", { class: "links" }, ...links);
  return el("section", { class: "card" }, el("h1", {}, title), intro ? el("p", { class: "muted" }, intro) : "", form, nav);
}

function navLink(text, href, go) {
  return el("a", { href, onclick: (e) => { e.preventDefault(); go(href); } }, text);
}

const email = () => field("Email", "email", "email", { autocomplete: "username" });
const newPassword = (label = "Password") =>
  field(label, "password", "password", { autocomplete: "new-password", minlength: "8" });

export function signInScreen({ go, signedIn }) {
  return formCard({
    title: "Sign in to Familio",
    fields: [email(), field("Password", "password", "password", { autocomplete: "current-password" })],
    submit: "Sign in",
    onSubmit: async (v) => signedIn(await api("POST", "/api/login", v)),
    links: [navLink("Forgot password?", "/reset", go), navLink("First time? Set up this server", "/setup", go)],
  });
}

export function setupScreen({ go, signedIn }) {
  return formCard({
    title: "Set up Familio",
    intro: "Create the first Admin account for this server.",
    fields: [email(), newPassword()],
    submit: "Create Admin account",
    onSubmit: async (v) => signedIn(await api("POST", "/api/setup", v)),
    links: [navLink("Already set up? Sign in", "/signin", go)],
  });
}

export function inviteScreen({ go, signedIn, token }) {
  return formCard({
    title: "Join Familio",
    intro: "Choose a password to accept your invitation.",
    fields: [newPassword("Choose a password")],
    submit: "Accept invitation",
    onSubmit: async (v) => signedIn(await api("POST", "/api/invitations/accept", { token, password: v.password })),
    links: [navLink("Already have an account? Sign in", "/signin", go)],
  });
}

export function resetScreen({ go, token }) {
  // With a token (from the reset link) set a new password; without, ask for one.
  if (token) {
    return formCard({
      title: "Choose a new password",
      fields: [newPassword("New password")],
      submit: "Set password",
      onSubmit: async (v, msg) => {
        await api("POST", "/api/password-reset/confirm", { token, password: v.password });
        msg.className = "msg ok";
        msg.textContent = "Password changed. You can sign in now.";
        setTimeout(() => go("/signin"), 1200);
      },
      links: [navLink("Back to sign in", "/signin", go)],
    });
  }
  return formCard({
    title: "Reset your password",
    intro: "Enter your email to get a reset link.",
    fields: [email()],
    submit: "Request reset",
    onSubmit: async (v, msg) => {
      const res = await api("POST", "/api/password-reset/request", { email: v.email });
      msg.className = "msg ok";
      msg.textContent = "If that email has an account, a reset link has been issued.";
      // Until email delivery exists the server hands back the token; continue
      // straight to choosing a password with it.
      if (res.token) go(`/reset?token=${encodeURIComponent(res.token)}`);
    },
    links: [navLink("Back to sign in", "/signin", go)],
  });
}
