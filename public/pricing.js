async function apiJson(path, options) {
  const init = { ...(options || {}) };
  const body = init.body;
  const hasBody = body !== undefined && body !== null && !(typeof body === "string" && body.length === 0);
  if (!hasBody) delete init.body;
  const headers = new Headers(init.headers || {});
  if (hasBody) headers.set("content-type", "application/json");
  else headers.delete("content-type");
  init.headers = headers;
  const res = await fetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
  }
  return res.json();
}

// Best-effort PWA support. Must not affect core billing UI if it fails.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// Keep pricing page consistent with the app's theme/device mode.
(() => {
  try {
    const THEME_KEY = "appTheme"; // shared with script.js
    const stored = localStorage.getItem(THEME_KEY) || "system";
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved = stored === "dark" || stored === "light" ? stored : (prefersDark ? "dark" : "light");
    document.documentElement.dataset.theme = resolved;
  } catch (_) {}
  try {
    const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    document.documentElement.dataset.device = (coarse || window.innerWidth <= 900) ? "mobile" : "desktop";
  } catch (_) {}
})();

function setText(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value || "";
}

function fmtLimit(label, value, suffix) {
  if (value === null || value === undefined) return `${label}: Unlimited`;
  return `${label}: ${value}${suffix || ""}`;
}

async function main() {
  const authEl = document.getElementById("pricingAuth");
  const msgEl = document.getElementById("pricingMsg");
  const grid = document.getElementById("plansGrid");
  const usageBox = document.getElementById("usageBox");
  const usageRows = document.getElementById("usageRows");

  let me = null;
  try {
    me = await apiJson("/api/v1/me", { method: "GET" });
  } catch (_) {
    // backend down
  }

  const user = me && me.user ? me.user : null;
  const userPlan = me && me.userPlan ? me.userPlan : { planKey: "free", status: "free" };

  if (!user) {
    if (authEl) authEl.textContent = "Sign in to choose a plan.";
    if (msgEl) msgEl.textContent = "Open the app, sign in, then return to this page.";
    return;
  }

  if (authEl) authEl.textContent = `Signed in as ${user.handle}`;
  if (msgEl) msgEl.textContent = `Current plan: ${userPlan.planKey} (${userPlan.status})`;

  try {
    const usage = await apiJson("/api/v1/usage/me", { method: "GET" });
    if (usageBox && usageRows) {
      usageBox.style.display = "";
      usageRows.innerHTML = "";
      const add = (t) => {
        const div = document.createElement("div");
        div.className = "usage-row";
        div.textContent = t;
        usageRows.appendChild(div);
      };
      add(`Plan: ${usage.plan.name} (${usage.plan.key})${usage.plan.unlimited ? " (Unlimited)" : ""}`);
      add(`Period: ${String(usage.period.start).slice(0, 10)} to ${String(usage.period.end).slice(0, 10)}`);
      add(`${fmtLimit("Monthly credits", usage.limits.monthlyCredits, "")} | Used: ${usage.usage.creditsUsed}`);
      add(`${fmtLimit("Saved links/mo", usage.limits.maxSavedLinksPerMonth, "")} | Used: ${usage.usage.savedLinksCreated}`);
      add(`${fmtLimit("Media MB/mo", usage.limits.maxMediaMBPerMonth, "")} | Used: ${Math.round((usage.usage.mediaBytesUploaded || 0) / (1024 * 1024))}`);
    }
  } catch (_) {}

  let plans = [];
  try {
    plans = await apiJson("/api/v1/plans", { method: "GET" });
  } catch (e) {
    if (msgEl) msgEl.textContent = "Unable to load plans (backend not running).";
    return;
  }

  let stripePlans = [];
  try {
    stripePlans = await apiJson("/api/v1/billing/plans", { method: "GET" });
  } catch (_) {
    stripePlans = [];
  }
  const stripeAvail = new Map();
  for (const p of stripePlans) stripeAvail.set(String(p.key), !!p.available);
  const stripeEnabled = stripePlans.some((p) => p && p.provider === "stripe" && p.available === true);

  grid.innerHTML = "";
  for (const p of plans) {
    const card = document.createElement("div");
    card.className = "plan-card";

    const name = document.createElement("div");
    name.className = "plan-name";
    name.textContent = p.name;
    card.appendChild(name);

    const desc = document.createElement("div");
    desc.className = "plan-desc";
    desc.textContent = p.key === "free" ? "Get started with monthly credits." : "Paid plan with higher limits.";
    card.appendChild(desc);

    const li1 = document.createElement("div");
    li1.className = "plan-li";
    li1.textContent = fmtLimit("Monthly credits", p.monthlyCredits, "");
    card.appendChild(li1);

    const li2 = document.createElement("div");
    li2.className = "plan-li";
    li2.textContent = fmtLimit("Saved links/mo", p.maxSavedLinksPerMonth, "");
    card.appendChild(li2);

    const li3 = document.createElement("div");
    li3.className = "plan-li";
    li3.textContent = fmtLimit("Media MB/mo", p.maxMediaMBPerMonth, "");
    card.appendChild(li3);

    const actions = document.createElement("div");
    actions.className = "plan-actions";
    const btn = document.createElement("button");
    btn.className = "plan-btn plan-btn-primary";
    btn.type = "button";
    btn.textContent = p.key === "free" ? "Choose Free" : `Upgrade to ${p.name}`;
    const canPay = p.key === "free" ? true : (stripeAvail.get(String(p.key)) === true);
    btn.disabled = !canPay;
    btn.title = canPay ? "" : "Stripe not configured";
    btn.addEventListener("click", async () => {
      try {
        const res = await apiJson("/api/v1/billing/me/checkout", {
          method: "POST",
          body: JSON.stringify({ planKey: String(p.key) }),
        });
        if (res && res.url) window.location.href = res.url;
      } catch (e) {
        alert("Unable to start checkout. Ensure Stripe is configured.");
      }
    });
    actions.appendChild(btn);

    const manage = document.createElement("button");
    manage.className = "plan-btn";
    manage.type = "button";
    manage.textContent = "Manage billing";
    manage.disabled = !stripeEnabled;
    manage.addEventListener("click", async () => {
      try {
        const res = await apiJson("/api/v1/billing/me/portal", { method: "POST", body: "{}" });
        if (res && res.url) window.location.href = res.url;
      } catch (_) {
        if (msgEl) msgEl.textContent = "Billing portal unavailable. Stripe is not configured on this server.";
      }
    });
    actions.appendChild(manage);

    card.appendChild(actions);

    const st = document.createElement("div");
    st.className = "plan-status";
    st.textContent = userPlan.planKey === p.key ? "Current plan" : "";
    card.appendChild(st);

    grid.appendChild(card);
  }
}

main().catch(() => {});
