async function apiJson(path, options) {
  const init = { ...(options || {}), credentials: 'same-origin' };
  const res = await fetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status} ${res.statusText}${text ? `: ${text}` : ''}`);
  }
  return res.json();
}

function pct(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function number(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function relativeDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch (_) { return iso; }
}

function chartColors() {
  const dark = document.documentElement.dataset.theme === 'dark';
  return {
    text: dark ? '#f1f3f6' : '#1f1f1f',
    muted: dark ? 'rgba(241,243,246,0.65)' : 'rgba(31,31,31,0.55)',
    grid: dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.08)',
    blue: '#0b5fff',
    green: '#25b47e',
    orange: '#ff8a00',
    cyan: '#39b8ff',
    pink: '#ff6b8a',
    gold: '#ffb703',
  };
}

function emptyLabels(count, prefix) {
  return Array.from({ length: count }, (_, idx) => `${prefix} ${idx + 1}`);
}

function createChart(ctx, config) {
  if (typeof window.Chart !== 'function') {
    throw new Error('Chart.js failed to load.');
  }
  return new Chart(ctx, {
    ...config,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: chartColors().text,
            boxWidth: 12,
            boxHeight: 12,
          },
        },
      },
      scales: config.options?.scales || {},
      ...config.options,
    },
  });
}

function updateChart(chart, labels, datasets) {
  chart.data.labels = labels;
  chart.data.datasets = datasets;
  chart.update();
}

function renderMetricCards(target, items) {
  target.innerHTML = '';
  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'analytics-card';
    card.innerHTML = `
      <div class="analytics-card-label">${item.label}</div>
      <div class="analytics-card-value">${item.value}</div>
      <div class="analytics-card-meta">${item.meta || ''}</div>
    `;
    target.appendChild(card);
  }
}

function renderCompactTable(target, config) {
  target.innerHTML = '';
  const rows = config.rows || [];
  const table = document.createElement('table');
  table.className = 'analytics-mini-table';
  table.innerHTML = `
    <thead>
      <tr>${config.columns.map((col) => `<th>${col.label}</th>`).join('')}</tr>
    </thead>
    <tbody>
      ${rows.length ? rows.map((row) => `
        <tr>${config.columns.map((col) => `<td>${col.render(row)}</td>`).join('')}</tr>
      `).join('') : `<tr><td colspan="${config.columns.length}" class="settings-hint">${config.emptyText || 'No data yet.'}</td></tr>`}
    </tbody>
  `;
  target.appendChild(table);
}

function renderTopShares(target, items, onSelect) {
  target.innerHTML = '';
  if (!items || items.length === 0) {
    target.innerHTML = '<tr><td colspan="9" class="settings-hint">No saved links have activity in this range yet.</td></tr>';
    return;
  }
  items.forEach((item) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><button type="button" class="analytics-link-btn">${item.code}</button></td>
      <td>${item.topic || 'Untitled'}</td>
      <td>${item.ownerLabel}</td>
      <td>${number(item.views)}</td>
      <td>${number(item.uniques)}</td>
      <td>${number(item.previews)}</td>
      <td>${number(item.visits)}</td>
      <td>${pct(item.previewRate)}</td>
      <td>${pct(item.ctr)}</td>
    `;
    tr.querySelector('button')?.addEventListener('click', () => onSelect(item.code));
    target.appendChild(tr);
  });
}

async function main() {
  const authStatusEl = document.getElementById('analyticsAuthStatus');
  const authErrorEl = document.getElementById('analyticsAuthError');
  const scopeEl = document.getElementById('analyticsScope');
  const rangeEl = document.getElementById('analyticsRange');
  const refreshBtn = document.getElementById('analyticsRefreshBtn');
  const exportBtn = document.getElementById('analyticsExportBtn');
  const updatedEl = document.getElementById('analyticsLastUpdated');

  const cardsEl = document.getElementById('analyticsCards');
  const campaignsEl = document.getElementById('analyticsCampaigns');
  const topicsEl = document.getElementById('analyticsTopics');
  const referrersEl = document.getElementById('analyticsReferrers');
  const audienceEl = document.getElementById('analyticsAudience');
  const sharesEl = document.getElementById('analyticsTopShares');

  const detailTitleEl = document.getElementById('analyticsDetailTitle');
  const detailMetaEl = document.getElementById('analyticsDetailMeta');
  const detailCardsEl = document.getElementById('analyticsDetailCards');
  const nodePerfEl = document.getElementById('analyticsNodePerformance');
  const attributionEl = document.getElementById('analyticsAttribution');
  const geoEl = document.getElementById('analyticsGeo');
  const techEl = document.getElementById('analyticsTech');
  const topUrlsEl = document.getElementById('analyticsTopUrls');

  if (typeof window.Chart !== 'function') {
    authStatusEl.textContent = 'Dashboard assets unavailable';
    authErrorEl.style.display = '';
    authErrorEl.textContent = 'Chart rendering could not start because the local Chart.js asset was not loaded.';
    return;
  }

  const colors = chartColors();
  const sharedScale = {
    x: {
      ticks: { color: colors.muted },
      grid: { color: colors.grid },
    },
    y: {
      ticks: { color: colors.muted },
      grid: { color: colors.grid },
      beginAtZero: true,
    },
  };

  const trendChart = createChart(document.getElementById('analyticsTrendChart'), {
    type: 'line',
    data: {
      labels: emptyLabels(7, 'Day'),
      datasets: [
        { label: 'Views', data: [0, 0, 0, 0, 0, 0, 0], borderColor: colors.blue, backgroundColor: 'rgba(11,95,255,0.15)', tension: 0.35, fill: true },
        { label: 'Previews', data: [0, 0, 0, 0, 0, 0, 0], borderColor: colors.green, backgroundColor: 'rgba(37,180,126,0.10)', tension: 0.35, fill: true },
        { label: 'Visits', data: [0, 0, 0, 0, 0, 0, 0], borderColor: colors.orange, backgroundColor: 'rgba(255,138,0,0.10)', tension: 0.35, fill: true },
      ],
    },
    options: { scales: sharedScale },
  });

  const funnelChart = createChart(document.getElementById('analyticsFunnelChart'), {
    type: 'bar',
    data: {
      labels: ['Views', 'Previews', 'Visits'],
      datasets: [{ label: 'Events', data: [0, 0, 0], backgroundColor: [colors.blue, colors.green, colors.orange], borderRadius: 10 }],
    },
    options: { scales: sharedScale, plugins: { legend: { display: false } } },
  });

  const attributionChart = createChart(document.getElementById('analyticsAttributionChart'), {
    type: 'doughnut',
    data: {
      labels: ['Direct', 'Campaign A', 'Campaign B', 'Campaign C'],
      datasets: [{ data: [1, 1, 1, 1], backgroundColor: [colors.blue, colors.green, colors.orange, colors.cyan], borderWidth: 0 }],
    },
    options: { plugins: { legend: { position: 'bottom' } } },
  });

  const detailTrendChart = createChart(document.getElementById('analyticsDetailTrendChart'), {
    type: 'line',
    data: {
      labels: emptyLabels(7, 'Day'),
      datasets: [
        { label: 'Views', data: [0, 0, 0, 0, 0, 0, 0], borderColor: colors.blue, tension: 0.35 },
        { label: 'Previews', data: [0, 0, 0, 0, 0, 0, 0], borderColor: colors.green, tension: 0.35 },
        { label: 'Visits', data: [0, 0, 0, 0, 0, 0, 0], borderColor: colors.orange, tension: 0.35 },
      ],
    },
    options: { scales: sharedScale },
  });

  const nodeChart = createChart(document.getElementById('analyticsNodeChart'), {
    type: 'bar',
    data: {
      labels: ['Node 1', 'Node 2', 'Node 3', 'Node 4'],
      datasets: [
        { label: 'Previews', data: [0, 0, 0, 0], backgroundColor: colors.green, borderRadius: 8 },
        { label: 'Visits', data: [0, 0, 0, 0], backgroundColor: colors.orange, borderRadius: 8 },
      ],
    },
    options: { scales: sharedScale },
  });

  let selectedCode = null;

  try {
    const me = await apiJson('/api/v1/me');
    if (!me.user) {
      authStatusEl.textContent = 'Sign in required';
      authErrorEl.style.display = '';
      authErrorEl.textContent = 'Please sign in on the main app first to open your analytics dashboard.';
      return;
    }
    authStatusEl.textContent = `Signed in as ${me.user.handle}`;
    scopeEl.innerHTML = '';
    const meOpt = document.createElement('option');
    meOpt.value = 'me';
    meOpt.textContent = `Personal (${me.user.handle})`;
    scopeEl.appendChild(meOpt);
    for (const org of me.organizations || []) {
      const opt = document.createElement('option');
      opt.value = `org:${org.id}`;
      opt.textContent = `Org: ${org.slug}`;
      scopeEl.appendChild(opt);
    }
  } catch (_) {
    authStatusEl.textContent = 'Unable to load account';
    authErrorEl.style.display = '';
    authErrorEl.textContent = 'The analytics dashboard could not verify your session.';
    return;
  }

  async function loadDetail(code) {
    if (!code) return;
    const query = new URLSearchParams({ scope: scopeEl.value, range: rangeEl.value });
    const detail = await apiJson(`/api/v1/analytics/v2/share/${encodeURIComponent(code)}?${query.toString()}`);
    detailTitleEl.textContent = `Link Detail: ${detail.code}`;
    detailMetaEl.textContent = `${detail.topic || 'Untitled'} - Created ${relativeDate(detail.createdAt)}`;

    renderMetricCards(detailCardsEl, [
      { label: 'Views', value: number(detail.totals.views), meta: `${number(detail.totals.uniques)} unique viewers` },
      { label: 'Previews', value: number(detail.totals.previews), meta: `Preview rate ${pct(detail.totals.previewRate)}` },
      { label: 'Visits', value: number(detail.totals.visits), meta: `CTR ${pct(detail.totals.ctr)}` },
    ]);

    updateChart(
      detailTrendChart,
      (detail.series || []).map((item) => String(item.bucket)),
      [
        { label: 'Views', data: (detail.series || []).map((item) => item.views || 0), borderColor: colors.blue, tension: 0.35, fill: false },
        { label: 'Previews', data: (detail.series || []).map((item) => item.previews || 0), borderColor: colors.green, tension: 0.35, fill: false },
        { label: 'Visits', data: (detail.series || []).map((item) => item.visits || 0), borderColor: colors.orange, tension: 0.35, fill: false },
      ],
    );

    updateChart(
      nodeChart,
      (detail.nodePerformance || []).map((item) => `Node ${item.nodeIndex}`),
      [
        { label: 'Previews', data: (detail.nodePerformance || []).map((item) => item.previews || 0), backgroundColor: colors.green, borderRadius: 8 },
        { label: 'Visits', data: (detail.nodePerformance || []).map((item) => item.visits || 0), backgroundColor: colors.orange, borderRadius: 8 },
      ],
    );

    renderCompactTable(nodePerfEl, {
      columns: [
        { label: 'Node', render: (row) => `Node ${row.nodeIndex}` },
        { label: 'Previews', render: (row) => number(row.previews) },
        { label: 'Visits', render: (row) => number(row.visits) },
        { label: 'Visit/Preview', render: (row) => pct(row.visitPerPreviewRate) },
      ],
      rows: detail.nodePerformance || [],
      emptyText: 'No node-level activity yet.',
    });

    renderCompactTable(attributionEl, {
      columns: [
        { label: 'Dimension', render: (row) => row.dimension },
        { label: 'Label', render: (row) => row.label },
        { label: 'Count', render: (row) => number(row.count) },
      ],
      rows: [
        ...(detail.attribution.campaigns || []).slice(0, 4).map((row) => ({ ...row, dimension: 'Campaign' })),
        ...(detail.attribution.sources || []).slice(0, 4).map((row) => ({ ...row, dimension: 'Source' })),
        ...(detail.attribution.mediums || []).slice(0, 4).map((row) => ({ ...row, dimension: 'Medium' })),
        ...(detail.attribution.referrers || []).slice(0, 4).map((row) => ({ ...row, dimension: 'Referrer' })),
      ],
      emptyText: 'No attribution data yet.',
    });

    renderCompactTable(geoEl, {
      columns: [
        { label: 'Geo', render: (row) => row.dimension },
        { label: 'Label', render: (row) => row.label },
        { label: 'Count', render: (row) => number(row.count) },
      ],
      rows: [
        ...(detail.geo.countries || []).slice(0, 5).map((row) => ({ ...row, dimension: 'Country' })),
        ...(detail.geo.cities || []).slice(0, 5).map((row) => ({ ...row, dimension: 'City' })),
      ],
      emptyText: 'No geo data yet.',
    });

    renderCompactTable(techEl, {
      columns: [
        { label: 'Tech', render: (row) => row.dimension },
        { label: 'Label', render: (row) => row.label },
        { label: 'Count', render: (row) => number(row.count) },
      ],
      rows: [
        ...(detail.tech.devices || []).slice(0, 4).map((row) => ({ ...row, dimension: 'Device' })),
        ...(detail.tech.browsers || []).slice(0, 4).map((row) => ({ ...row, dimension: 'Browser' })),
        ...(detail.tech.os || []).slice(0, 4).map((row) => ({ ...row, dimension: 'OS' })),
      ],
      emptyText: 'No technology data yet.',
    });

    renderCompactTable(topUrlsEl, {
      columns: [
        { label: 'Destination URL', render: (row) => row.url },
        { label: 'Visits', render: (row) => number(row.visits) },
      ],
      rows: detail.topUrls || [],
      emptyText: 'No outbound link visits yet.',
    });
  }

  async function loadOverview() {
    const query = new URLSearchParams({ scope: scopeEl.value, range: rangeEl.value });
    const overview = await apiJson(`/api/v1/analytics/v2/overview?${query.toString()}`);
    document.getElementById('analyticsTitle').textContent = overview.label;
    document.getElementById('analyticsSubtitle').textContent = `${overview.activeShares} active links in the selected period.`;
    updatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;

    renderMetricCards(cardsEl, [
      { label: 'Views', value: number(overview.totals.views), meta: `${overview.trend.viewsDeltaPct >= 0 ? '+' : ''}${overview.trend.viewsDeltaPct}% vs previous period` },
      { label: 'Unique Viewers', value: number(overview.totals.uniques), meta: `${overview.trend.uniquesDeltaPct >= 0 ? '+' : ''}${overview.trend.uniquesDeltaPct}% vs previous period` },
      { label: 'Previews', value: number(overview.totals.previews), meta: `Preview rate ${pct(overview.totals.previewRate)}` },
      { label: 'Visits', value: number(overview.totals.visits), meta: `CTR ${pct(overview.totals.visitRate)}` },
      { label: 'Play Starts', value: number(overview.totals.playStarts), meta: `${number(overview.totals.playStops)} play stops` },
      { label: 'Visit per Preview', value: pct(overview.totals.visitPerPreviewRate), meta: `${overview.activeShares} active links` },
    ]);

    updateChart(
      trendChart,
      (overview.series || []).map((item) => String(item.bucket)),
      [
        { label: 'Views', data: (overview.series || []).map((item) => item.views || 0), borderColor: colors.blue, backgroundColor: 'rgba(11,95,255,0.12)', tension: 0.35, fill: true },
        { label: 'Previews', data: (overview.series || []).map((item) => item.previews || 0), borderColor: colors.green, backgroundColor: 'rgba(37,180,126,0.10)', tension: 0.35, fill: true },
        { label: 'Visits', data: (overview.series || []).map((item) => item.visits || 0), borderColor: colors.orange, backgroundColor: 'rgba(255,138,0,0.10)', tension: 0.35, fill: true },
      ],
    );

    updateChart(
      funnelChart,
      ['Views', 'Previews', 'Visits'],
      [{ label: 'Events', data: [overview.totals.views, overview.totals.previews, overview.totals.visits], backgroundColor: [colors.blue, colors.green, colors.orange], borderRadius: 10 }],
    );

    const attributionRows = overview.topCampaigns && overview.topCampaigns.length > 0
      ? overview.topCampaigns.slice(0, 5)
      : [{ campaign: '(unattributed)', views: 1 }];
    updateChart(
      attributionChart,
      attributionRows.map((item) => item.campaign),
      [{
        data: attributionRows.map((item) => item.views || 0),
        backgroundColor: [colors.blue, colors.green, colors.orange, colors.cyan, colors.pink, colors.gold],
        borderWidth: 0,
      }],
    );

    renderCompactTable(campaignsEl, {
      columns: [
        { label: 'Dimension', render: (row) => row.dimension },
        { label: 'Label', render: (row) => row.label || row.campaign },
        { label: 'Views', render: (row) => number(row.views) },
        { label: 'Visits', render: (row) => number(row.visits) },
      ],
      rows: [
        ...(overview.topCampaigns || []).slice(0, 5).map((row) => ({ ...row, dimension: 'Campaign' })),
        ...(overview.topSources || []).slice(0, 5).map((row) => ({ ...row, dimension: 'Source', views: row.count, visits: 0 })),
        ...(overview.topMediums || []).slice(0, 5).map((row) => ({ ...row, dimension: 'Medium', views: row.count, visits: 0 })),
      ],
      emptyText: 'No campaign or multi-channel attribution data yet.',
    });

    renderCompactTable(topicsEl, {
      columns: [
        { label: 'Topic', render: (row) => row.topic },
        { label: 'Views', render: (row) => number(row.views) },
        { label: 'Visits', render: (row) => number(row.visits) },
      ],
      rows: overview.topTopics || [],
      emptyText: 'No topic performance yet.',
    });

    renderCompactTable(referrersEl, {
      columns: [
        { label: 'Referrer', render: (row) => row.label },
        { label: 'Count', render: (row) => number(row.count) },
      ],
      rows: overview.topReferrers || [],
      emptyText: 'No referrer data yet.',
    });

    renderCompactTable(audienceEl, {
      columns: [
        { label: 'Dimension', render: (row) => row.dimension },
        { label: 'Label', render: (row) => row.label },
        { label: 'Count', render: (row) => number(row.count) },
      ],
      rows: [
        ...(overview.topCountries || []).slice(0, 3).map((row) => ({ ...row, dimension: 'Country' })),
        ...(overview.topCities || []).slice(0, 3).map((row) => ({ ...row, dimension: 'City' })),
        ...(overview.topDevices || []).slice(0, 3).map((row) => ({ ...row, dimension: 'Device' })),
        ...(overview.topBrowsers || []).slice(0, 3).map((row) => ({ ...row, dimension: 'Browser' })),
        ...(overview.topOS || []).slice(0, 3).map((row) => ({ ...row, dimension: 'OS' })),
      ],
      emptyText: 'No audience geography or technology data yet.',
    });

    const topGlobalUrlsEl = document.getElementById('analyticsTopGlobalUrls');
    if (topGlobalUrlsEl) {
      renderCompactTable(topGlobalUrlsEl, {
        columns: [
          { label: 'Destination URL', render: (row) => row.url },
          { label: 'Total Visits', render: (row) => number(row.visits) },
        ],
        rows: overview.topUrls || [],
        emptyText: 'No global outbound visits recorded yet.',
      });
    }

    renderTopShares(sharesEl, overview.topShares, async (code) => {
      selectedCode = code;
      await loadDetail(code);
    });

    if (!selectedCode && overview.topShares && overview.topShares.length > 0) {
      selectedCode = overview.topShares[0].code;
    }
    if (selectedCode) await loadDetail(selectedCode);
  }

  refreshBtn.addEventListener('click', () => void loadOverview());
  scopeEl.addEventListener('change', () => void loadOverview());
  rangeEl.addEventListener('change', () => void loadOverview());
  exportBtn.addEventListener('click', () => {
    const query = new URLSearchParams({ scope: scopeEl.value, range: rangeEl.value });
    window.location.href = `/api/v1/analytics/v2/export.csv?${query.toString()}`;
  });

  await loadOverview();
}

void main().catch((error) => {
  const authStatusEl = document.getElementById('analyticsAuthStatus');
  const authErrorEl = document.getElementById('analyticsAuthError');

  if (authStatusEl) authStatusEl.textContent = 'Dashboard unavailable';
  if (authErrorEl) {
    authErrorEl.style.display = '';
    authErrorEl.textContent = error instanceof Error ? error.message : 'The analytics dashboard could not be initialized.';
  }

  console.error(error);
});
