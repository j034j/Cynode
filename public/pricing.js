/* ============================================================
   pricing.js — Cynode Plans & Checkout Page
   Connects to /api/v1/plans, /api/v1/billing/*, /api/v1/usage/me
   Payment gateway: Stripe Checkout (supports Card, Apple Pay, Google Pay, PayPal*)
   ============================================================ */

'use strict';

/* ── PWA Service Worker ── */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

/* ── Theme + device detection (matches script.js) ── */
(() => {
  try {
    const THEME_KEY = 'appTheme';
    const stored = localStorage.getItem(THEME_KEY) || 'system';
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const resolved = stored === 'dark' || stored === 'light' ? stored : (prefersDark ? 'dark' : 'light');
    document.documentElement.dataset.theme = resolved;
  } catch (_) {}
  try {
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    document.documentElement.dataset.device = (coarse || window.innerWidth <= 900) ? 'mobile' : 'desktop';
  } catch (_) {}
})();

/* ── API helper ── */
async function apiJson(path, options = {}) {
  const init = { credentials: 'include', ...options };
  const body = init.body;
  const hasBody = body !== undefined && body !== null && body !== '';
  if (!hasBody) delete init.body;
  const headers = new Headers(init.headers || {});
  if (hasBody) headers.set('content-type', 'application/json');
  init.headers = headers;
  const res = await fetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = `HTTP ${res.status}`;
    try { const j = JSON.parse(text); msg = j.error || j.message || msg; } catch (_) {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/* ── Plan metadata (mirrors usage.ts) ── */
const PLAN_META = {
  free: {
    icon: '🚀', label: 'Free', variant: 'free', priceLabel: '$0', period: '/ month',
    desc: 'Perfect for getting started. Build and share nodegraphs with monthly credits.',
    features: [
      '150 monthly credits', '25 saved nodegraphs / month', '75 MB media storage / month',
      '14-day analytics retention', 'PWA & offline support', 'Community support'
    ],
  },
  pro: {
    icon: '⚡', label: 'Pro', variant: 'pro', priceLabel: 'Contact us', period: '',
    desc: 'For power users and creators who need higher limits and longer analytics history.',
    features: [
      '5,000 monthly credits', '1,500 saved nodegraphs / month', '2 GB media storage / month',
      '180-day analytics retention', 'Priority playback delivery', 'Email support'
    ],
    featured: true, badge: 'Most Popular',
  },
  ultra: {
    icon: '🌟', label: 'Ultra', variant: 'ultra', priceLabel: 'Contact us', period: '',
    desc: 'Unlimited for organisations and heavy production usage. No caps, no surprises.',
    features: [
      'Unlimited credits', 'Unlimited saved nodegraphs', 'Unlimited media storage',
      '365-day analytics retention', 'Branded short links', 'Dedicated support'
    ],
    badge: 'Enterprise',
  },
};

/* ── Comparison table rows ── */
const COMPARE_ROWS = [
  { label: 'Monthly credits', values: ['150', '5,000', 'Unlimited'] },
  { label: 'Saved nodegraphs/mo', values: ['25', '1,500', 'Unlimited'] },
  { label: 'Media storage/mo', values: ['75 MB', '2 GB', 'Unlimited'] },
  { label: 'Analytics retention', values: ['14 days', '180 days', '365 days'] },
  { label: 'Offline / PWA support', values: ['✓', '✓', '✓'], classes: ['check-cell', 'check-cell', 'check-cell'] },
  { label: 'Branded short links', values: ['—', '—', '✓'], classes: ['x-cell', 'x-cell', 'check-cell'] },
  { label: 'Organization billing', values: ['—', '✓', '✓'], classes: ['x-cell', 'check-cell', 'check-cell'] },
  { label: 'Priority delivery', values: ['—', '✓', '✓'], classes: ['x-cell', 'check-cell', 'check-cell'] },
  { label: 'Dedicated support', values: ['—', '—', '✓'], classes: ['x-cell', 'x-cell', 'check-cell'] },
];

/* ── UI helpers ── */
function showBanner(msg, type = 'info') {
  const el = document.getElementById('statusBanner');
  if (!el) return;
  el.className = type;
  el.textContent = msg;
}
function hideBanner() {
  const el = document.getElementById('statusBanner');
  if (el) { el.className = ''; el.textContent = ''; el.style.display = 'none'; }
}
function setBtnLoading(btn, loading, text) {
  if (!btn) return;
  if (loading) {
    btn._origText = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> ${text || 'Loading…'}`;
  } else {
    btn.disabled = false;
    btn.textContent = btn._origText || text || 'Done';
  }
}

/* ── Usage bar ── */
function usagePct(used, limit) {
  if (limit === null || limit === undefined) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}
function barClass(pct) {
  if (pct >= 90) return 'danger';
  if (pct >= 70) return 'warn';
  return '';
}
function fmtNum(n) {
  if (n === null || n === undefined) return '∞';
  return Number(n).toLocaleString();
}

function buildUsageCard(labelText, used, limit, unit = '') {
  const pct = usagePct(used, limit);
  const cls = barClass(pct);
  const card = document.createElement('div');
  card.className = 'usage-card';
  card.innerHTML = `
    <div class="usage-card-label">${labelText}</div>
    <div class="usage-card-value">${fmtNum(used)}${unit}</div>
    <div class="usage-card-sub">of ${limit === null ? 'unlimited' : fmtNum(limit) + unit}</div>
    ${limit !== null ? `<div class="usage-bar"><div class="usage-bar-fill ${cls}" style="width:${pct}%"></div></div>` : ''}
  `;
  return card;
}

/* ── Plan card builder ── */
function buildPlanCard(plan, currentPlanKey, stripeAvail, user, onCheckout, onPortal) {
  const meta = PLAN_META[plan.key] || {};
  const isCurrent = currentPlanKey === plan.key;
  const canCheckout = plan.key === 'free' || (stripeAvail.get(plan.key) === true);

  const card = document.createElement('div');
  card.className = `plan-card${meta.featured ? ' featured' : ''}`;

  if (meta.badge) {
    const badge = document.createElement('div');
    badge.className = `plan-badge ${plan.key}-badge`;
    badge.textContent = meta.badge;
    card.appendChild(badge);
  }

  /* Icon */
  const icon = document.createElement('div');
  icon.className = `plan-icon ${plan.key}-icon`;
  icon.textContent = meta.icon || '📦';
  card.appendChild(icon);

  /* Name + price */
  const nameEl = document.createElement('div');
  nameEl.className = `plan-name ${plan.key}-name`;
  nameEl.textContent = meta.label || plan.name;
  card.appendChild(nameEl);

  const priceEl = document.createElement('div');
  priceEl.className = 'plan-price';
  priceEl.innerHTML = `<span class="plan-price-amount">${meta.priceLabel || '—'}</span><span class="plan-price-period"> ${meta.period || ''}</span>`;
  card.appendChild(priceEl);

  /* Desc */
  const descEl = document.createElement('div');
  descEl.className = 'plan-desc';
  descEl.textContent = meta.desc || plan.description || '';
  card.appendChild(descEl);

  /* Features */
  const ul = document.createElement('ul');
  ul.className = 'plan-features';
  const featureList = meta.features || [];
  featureList.forEach(f => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="check ${plan.key}-check">✓</span><span>${f}</span>`;
    ul.appendChild(li);
  });
  card.appendChild(ul);

  /* CTA button */
  const cta = document.createElement('button');
  cta.type = 'button';
  cta.id = `planCta_${plan.key}`;

  if (isCurrent) {
    cta.className = 'plan-cta current-cta';
    cta.textContent = '✓ Current plan';
    cta.disabled = true;
  } else if (!user) {
    cta.className = `plan-cta ${plan.key}-cta`;
    cta.textContent = plan.key === 'free' ? 'Sign in to start free' : `Upgrade to ${meta.label || plan.name}`;
    cta.addEventListener('click', () => { window.location.href = '/'; });
  } else if (!canCheckout) {
    cta.className = `plan-cta ${plan.key}-cta`;
    cta.textContent = `${meta.label || plan.name} — coming soon`;
    cta.disabled = true;
    cta.title = 'Payment processing not yet configured on this server.';
  } else {
    cta.className = `plan-cta ${plan.key}-cta`;
    cta.textContent = plan.key === 'free' ? 'Switch to Free' : `Upgrade to ${meta.label || plan.name}`;
    cta.addEventListener('click', () => onCheckout(plan, cta));
  }
  card.appendChild(cta);

  /* Manage link (only shown for current paid plan) */
  if (isCurrent && plan.key !== 'free' && user) {
    const manageBtn = document.createElement('button');
    manageBtn.className = 'plan-manage-link';
    manageBtn.type = 'button';
    manageBtn.textContent = 'Manage billing & payment methods →';
    manageBtn.addEventListener('click', () => onPortal(manageBtn));
    card.appendChild(manageBtn);
  }

  /* Current plan status tag */
  if (isCurrent) {
    const tag = document.createElement('div');
    tag.className = 'plan-status-tag active';
    tag.innerHTML = '● Active';
    card.appendChild(tag);
  }

  return card;
}

/* ── Comparison table builder ── */
function buildCompareTable() {
  const tbody = document.getElementById('compareBody');
  if (!tbody) return;
  COMPARE_ROWS.forEach(row => {
    const tr = document.createElement('tr');
    const tdLabel = document.createElement('td');
    tdLabel.textContent = row.label;
    tr.appendChild(tdLabel);
    row.values.forEach((v, i) => {
      const td = document.createElement('td');
      td.textContent = v;
      const cls = row.classes && row.classes[i];
      if (cls) td.className = cls;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

/* ── Handle billing success / cancel query params ── */
function handleBillingParams() {
  const params = new URLSearchParams(window.location.search);
  const billing = params.get('billing');
  if (billing === 'success') {
    showBanner('🎉 Payment successful! Your plan is now active.', 'success');
    window.history.replaceState({}, document.title, window.location.pathname);
  } else if (billing === 'cancel') {
    showBanner('Checkout canceled — no charge was made. You can upgrade any time.', 'info');
    window.history.replaceState({}, document.title, window.location.pathname);
  } else if (billing === 'free') {
    showBanner('Switched to Free plan.', 'info');
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

/* ── Main ── */
async function main() {
  handleBillingParams();

  const plansGrid = document.getElementById('plansGrid');
  const usageSection = document.getElementById('usageSection');
  const usageGrid = document.getElementById('usageGrid');
  const signInGate = document.getElementById('signInGate');
  const navUserBadge = document.getElementById('navUserBadge');
  const faqSection = document.getElementById('faqSection');
  const stripeTrust = document.getElementById('stripeTrust');
  const notConfiguredNotice = document.getElementById('notConfiguredNotice');

  /* ── 1. Fetch user session ── */
  let me = null;
  try { me = await apiJson('/api/v1/me', { method: 'GET' }); } catch (_) {}
  const user = me && me.user ? me.user : null;
  const userPlan = (me && me.userPlan) ? me.userPlan : { planKey: 'free', status: 'free' };

  if (navUserBadge && user) {
    navUserBadge.textContent = `@${user.handle}`;
    navUserBadge.style.display = '';
  }

  /* ── 2. Fetch plans catalog ── */
  let plans = [];
  try { plans = await apiJson('/api/v1/plans', { method: 'GET' }); } catch (_) {}
  if (!plans || plans.length === 0) {
    showBanner('Unable to load plans. The backend may be starting up — try refreshing in a moment.', 'error');
    return;
  }

  /* ── 3. Fetch Stripe availability ── */
  let stripePlans = [];
  try { stripePlans = await apiJson('/api/v1/billing/plans', { method: 'GET' }); } catch (_) {}
  const stripeAvail = new Map();
  for (const p of stripePlans) stripeAvail.set(String(p.key), !!p.available);
  const stripeConfigured = stripePlans.some(p => p && p.provider === 'stripe' && p.available === true);

  if (!stripeConfigured && notConfiguredNotice) {
    notConfiguredNotice.classList.add('show');
  }

  /* ── 4. Checkout handler ── */
  async function handleCheckout(plan, btn) {
    hideBanner();
    setBtnLoading(btn, true, 'Redirecting to checkout…');
    try {
      const res = await apiJson('/api/v1/billing/me/checkout', {
        method: 'POST',
        body: JSON.stringify({
          planKey: plan.key,
          successPath: '/pricing?billing=success',
          cancelPath: '/pricing?billing=cancel',
        }),
      });
      if (res && res.url) {
        window.location.href = res.url;
      } else {
        throw new Error('no_url');
      }
    } catch (e) {
      setBtnLoading(btn, false);
      const msg = e.status === 501
        ? 'Payment processing is not configured on this server yet. Please contact the administrator.'
        : e.status === 402
        ? 'Your plan quota has been reached. Please manage your subscription first.'
        : `Checkout failed: ${e.message || 'Unknown error'}. Please try again.`;
      showBanner(msg, 'error');
    }
  }

  /* ── 5. Portal handler ── */
  async function handlePortal(btn) {
    hideBanner();
    setBtnLoading(btn, true, 'Opening billing portal…');
    try {
      const res = await apiJson('/api/v1/billing/me/portal', { method: 'POST', body: '{}' });
      if (res && res.url) {
        window.location.href = res.url;
      } else {
        throw new Error('no_url');
      }
    } catch (e) {
      setBtnLoading(btn, false);
      const msg = e.status === 404
        ? 'No billing account found. Subscribe to a paid plan first.'
        : e.status === 501
        ? 'Billing portal not configured on this server.'
        : `Unable to open billing portal: ${e.message || 'Unknown error'}`;
      showBanner(msg, 'error');
    }
  }

  /* ── 6. Build plan cards ── */
  if (plansGrid) {
    plansGrid.style.display = '';
    plans.forEach(plan => {
      const card = buildPlanCard(
        plan,
        userPlan.planKey,
        stripeAvail,
        user,
        handleCheckout,
        handlePortal
      );
      plansGrid.appendChild(card);
    });
  }

  /* ── 7. Show/hide sign-in gate ── */
  if (!user && signInGate) {
    signInGate.style.display = '';
  }

  /* ── 8. Usage stats (only if signed in) ── */
  if (user && usageSection && usageGrid) {
    try {
      const usage = await apiJson('/api/v1/usage/me', { method: 'GET' });
      usageSection.style.display = '';
      usageGrid.innerHTML = '';
      usageGrid.appendChild(buildUsageCard('Credits Used', usage.usage.creditsUsed, usage.limits.monthlyCredits));
      usageGrid.appendChild(buildUsageCard('Saved Links', usage.usage.savedLinksCreated, usage.limits.maxSavedLinksPerMonth));
      usageGrid.appendChild(buildUsageCard(
        'Media Used',
        Math.round((usage.usage.mediaBytesUploaded || 0) / (1024 * 1024)),
        usage.limits.maxMediaMBPerMonth,
        ' MB'
      ));
    } catch (_) {
      // usage endpoint unavailable, skip gracefully
    }
  }

  /* ── 9. Comparison table ── */
  buildCompareTable();
  if (faqSection) faqSection.style.display = '';
  if (stripeTrust) stripeTrust.style.display = '';
}

main().catch(err => {
  console.error('[Pricing] Fatal error:', err);
  const banner = document.getElementById('statusBanner');
  if (banner) {
    banner.className = 'error';
    banner.textContent = 'Something went wrong loading the pricing page. Please try refreshing.';
  }
});
