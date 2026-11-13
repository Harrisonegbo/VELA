(() => {
  const style = document.createElement('style');
  style.textContent = `
    body:not(.pw-authenticated) .app { visibility: hidden; }
    #pwAuthGate { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center; padding: 20px; background: #f3f6fa; }
    #pwAuthGate[hidden] { display: none; }
    #pwAuthGate .pw-auth-card { width: min(440px, 100%); padding: 26px; border: 1px solid #dfe6ef; border-radius: 14px; background: #fff; box-shadow: 0 18px 55px #18304a1c; }
    #pwAuthGate h1 { margin: 0 0 8px; font-size: 23px; }
    #pwAuthGate p { color: #64748b; font-size: 13px; }
    #pwAuthGate label { display: block; margin: 14px 0 6px; font-size: 12px; font-weight: 650; }
    #pwAuthGate input { width: 100%; padding: 10px 12px; border: 1px solid #d6deea; border-radius: 8px; }
    #pwAuthGate .pw-auth-switch { display: flex; justify-content: center; gap: 6px; align-items: center; }
    #pwAuthGate .pw-auth-switch button { border: 0; background: none; color: #2676ee; font-weight: 700; }
    #pwAuthMessage { min-height: 20px; color: #9a5a00 !important; }
  `;
  document.head.append(style);

  document.body.insertAdjacentHTML('beforeend', `
    <section id="pwAuthGate" aria-labelledby="pwAuthTitle">
      <form class="pw-auth-card" id="pwAuthForm">
        <h1 id="pwAuthTitle">Sign in to COMPSUO</h1>
        <p id="pwAuthDescription">Sign in with your account to access this workspace.</p>
        <label for="pwApiUrl">Backend API URL</label>
        <input id="pwApiUrl" type="url" autocomplete="url" required>
        <label for="pwEmail">Email</label>
        <input id="pwEmail" type="email" autocomplete="username" required>
        <label for="pwPassword">Password</label>
        <input id="pwPassword" type="password" autocomplete="current-password" minlength="12" required>
        <div id="pwBootstrapField" hidden>
          <label for="pwBootstrapToken">Initial administrator setup token</label>
          <input id="pwBootstrapToken" type="password" autocomplete="off">
        </div>
        <p id="pwAuthMessage" role="status"></p>
        <button class="btn primary" type="submit" style="width:100%">Sign in</button>
        <p class="pw-auth-switch"><span id="pwAuthSwitchText">Need an account?</span><button type="button" id="pwAuthSwitch">Create account</button></p>
      </form>
    </section>
  `);

  let quickBooksStatus = null;
  let currentUser = null;
  let authMode = 'login';
  let quickBooksData = null;
  let quickBooksItems = [];
  let providerHealth = null;
  let lastClientRefreshAt = 0;
  let clientRefreshInProgress = false;
  let backendLoadLiveData = pwLoadLiveData;
  let originalRenderAll = renderAll;
  let originalEditNegotiation = editNegotiation;
  let originalReadAlert = readAlert;

  function loadNegotiations() {
    try {
      const saved = JSON.parse(localStorage.getItem('compsuoNegotiations') || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch (error) {
      console.warn('Could not load locally saved negotiation drafts.', error);
      return [];
    }
  }

  function setEmptyWorkspace() {
    competitors = [];
    invoices = [];
    alerts = [];
    savings = [];
    suppliers = [];
    negotiations = loadNegotiations();
    quickBooksItems = [];
    quickBooksData = null;
  }

  function showGate(message) {
    document.body.classList.remove('pw-authenticated');
    $('#pwAuthGate').hidden = false;
    $('#pwApiUrl').value = PW_API_BASE;
    $('#pwAuthMessage').textContent = message || 'Sign in to continue.';
  }

  function setAuthMode(mode) {
    authMode = mode;
    const registering = mode === 'register';
    $('#pwAuthTitle').textContent = registering ? 'Create a COMPSUO account' : 'Sign in to COMPSUO';
    $('#pwAuthDescription').textContent = registering
      ? 'New accounts need administrator approval. The first account requires the setup token.'
      : 'Sign in with your account to access this workspace.';
    $('#pwPassword').autocomplete = registering ? 'new-password' : 'current-password';
    $('#pwPassword').minLength = registering ? 12 : 1;
    $('#pwBootstrapField').hidden = !registering;
    $('#pwAuthForm button[type="submit"]').textContent = registering ? 'Create account' : 'Sign in';
    $('#pwAuthSwitchText').textContent = registering ? 'Already have an account?' : 'Need an account?';
    $('#pwAuthSwitch').textContent = registering ? 'Sign in' : 'Create account';
    $('#pwAuthMessage').textContent = '';
  }

  function hideGate() {
    document.body.classList.add('pw-authenticated');
    $('#pwAuthGate').hidden = true;
    $('#pwPassword').value = '';
  }

  function setIdentity() {
    const label = $('.user-label');
    const avatar = $('.avatar');
    if (!currentUser || !label || !avatar) return;
    label.querySelector('b').textContent = currentUser.email;
    label.querySelector('div').textContent = `${currentUser.role} account`;
    avatar.textContent = currentUser.email.slice(0, 2).toUpperCase();
    avatar.setAttribute('aria-label', currentUser.email);
    installAccountControls();
  }

  function installAccountControls() {
    const saveButton = $('#saveSettings');
    if (!saveButton || $('#pwAccountControls')) return;
    const section = document.createElement('section');
    section.id = 'pwAccountControls';
    section.style.cssText = 'margin-top:20px;padding-top:16px;border-top:1px solid var(--line)';
    section.innerHTML = `
      <h3>Account security</h3>
      <div class="form-grid">
        <div class="field"><label for="pwCurrentPassword">Current password</label><input id="pwCurrentPassword" type="password" autocomplete="current-password"></div>
        <div class="field"><label for="pwNewPassword">New password (at least 12 characters)</label><input id="pwNewPassword" type="password" autocomplete="new-password" minlength="12"></div>
      </div>
      <p id="pwPasswordMessage" role="status"></p>
      <button class="btn" type="button" id="pwChangePassword">Change password</button>
    `;
    saveButton.parentElement.insertAdjacentElement('afterend', section);
    $('#pwChangePassword').addEventListener('click', async () => {
      const current = $('#pwCurrentPassword').value;
      const next = $('#pwNewPassword').value;
      const message = $('#pwPasswordMessage');
      if (!current || next.length < 12) {
        message.textContent = 'Enter your current password and a new password of at least 12 characters.';
        return;
      }
      try {
        await pwApi('/api/auth/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ current_password: current, new_password: next }),
        });
        $('#pwCurrentPassword').value = '';
        $('#pwNewPassword').value = '';
        message.textContent = 'Password changed. Other active sessions have been signed out.';
      } catch (error) {
        message.textContent = `Could not change password: ${error.message}`;
      }
    });
  }

  async function renderAdminPanel() {
    const settings = $('#page-settings .card');
    if (!settings || currentUser?.role !== 'admin') return;
    let panel = $('#pwAdminPanel');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'pwAdminPanel';
      panel.style.cssText = 'margin-top:24px;padding-top:18px;border-top:1px solid var(--line)';
      settings.append(panel);
    }
    panel.innerHTML = '<h2>Workspace access & audit</h2><p>Approve registrations, assign roles, disable accounts, and review recent write activity.</p><div id="pwUserList">Loading accounts…</div><h3 style="margin-top:18px">Recent audit events</h3><div id="pwAuditList">Loading audit events…</div>';
    try {
      const [users, events] = await Promise.all([pwApi('/api/admin/users'), pwApi('/api/admin/audit?limit=50')]);
      $('#pwUserList').innerHTML = users.map(user => `
        <div class="mini-row" data-user-id="${user.id}">
          <div class="mini-info"><b>${esc(user.email)}</b><small>${user.approved ? 'Approved' : 'Awaiting approval'} · ${user.active ? 'Active' : 'Disabled'}</small></div>
          <select class="pw-role" aria-label="Role for ${esc(user.email)}">
            ${['admin','editor','viewer'].map(role => `<option value="${role}" ${role === user.role ? 'selected' : ''}>${role}</option>`).join('')}
          </select>
          ${user.approved ? '' : '<button class="btn small pw-approve">Approve</button>'}
          <button class="btn small pw-toggle">${user.active ? 'Disable' : 'Enable'}</button>
        </div>
      `).join('') || '<p>No accounts found.</p>';
      $('#pwAuditList').innerHTML = events.map(event => `
        <div class="mini-row"><div class="mini-info"><b>${esc(event.actor_email)} · ${esc(event.action)} ${esc(event.path)}</b><small>HTTP ${event.status_code} · ${esc(pwFmtDate(event.created_at))}</small></div></div>
      `).join('') || '<p>No audit events recorded.</p>';
      $('#pwUserList').querySelectorAll('.mini-row[data-user-id]').forEach(row => {
        row.querySelector('.pw-approve')?.addEventListener('click', async () => {
          try { await pwApi(`/api/admin/users/${row.dataset.userId}/approve`, { method: 'POST' }); await renderAdminPanel(); }
          catch (error) { toast(`Could not approve account: ${error.message}`); }
        });
        row.querySelector('.pw-toggle')?.addEventListener('click', async () => {
          const user = users.find(item => String(item.id) === row.dataset.userId);
          try { await pwApi(`/api/admin/users/${row.dataset.userId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !user.active }) }); await renderAdminPanel(); }
          catch (error) { toast(`Could not update account: ${error.message}`); }
        });
        row.querySelector('.pw-role')?.addEventListener('change', async event => {
          try { await pwApi(`/api/admin/users/${row.dataset.userId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: event.target.value }) }); await renderAdminPanel(); }
          catch (error) { toast(`Could not update role: ${error.message}`); }
        });
      });
    } catch (error) {
      panel.insertAdjacentHTML('beforeend', `<p role="status">Could not load access controls: ${esc(error.message)}</p>`);
    }
  }

  async function request(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', ...options });
    const body = await response.json().catch(() => ({}));
    if (response.status === 404) {
      throw new Error('Backend API route not found (404). Verify that this URL points to the deployed COMPSUO API service and that its latest backend deployment succeeded.');
    }
    if (!response.ok) throw new Error(body.detail || `Request failed (${response.status}).`);
    return body;
  }

  async function signIn(event) {
    event.preventDefault();
    const message = $('#pwAuthMessage');
    const button = $('#pwAuthForm button[type="submit"]');
    const enteredBase = pwSecureApiBase($('#pwApiUrl').value);
    if (!enteredBase) {
      message.textContent = 'Enter the backend API URL.';
      return;
    }
    PW_API_BASE = enteredBase;
    localStorage.setItem('compsuoApiBase', PW_API_BASE);
    button.disabled = true;
    message.textContent = 'Connecting…';
    try {
      const payload = {
        email: $('#pwEmail').value.trim(),
        password: $('#pwPassword').value,
      };
      if (authMode === 'register') payload.bootstrap_token = $('#pwBootstrapToken').value;
      const result = await request(`${PW_API_BASE}/api/auth/${authMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (authMode === 'register' && !result.approved) {
        message.textContent = result.message;
        return;
      }
      currentUser = result.user || currentUser;
      await boot();
    } catch (error) {
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  function mapQuickBooksData() {
    if (!quickBooksData) {
      suppliers = [];
      quickBooksItems = [];
      return;
    }
    if (quickBooksData.company_name && $('#businessSelect')?.options[0]) {
      $('#businessSelect').options[0].text = quickBooksData.company_name;
      $('#settingBusiness').value = quickBooksData.company_name;
    }
    suppliers = quickBooksData.vendors.map(vendor => ({
      id: vendor.id,
      name: vendor.name,
      category: 'QuickBooks vendor',
      date: 'Live from QuickBooks',
      trend: '—',
      status: vendor.active ? 'Active' : 'Inactive',
    }));
    quickBooksItems = quickBooksData.items;
    const uploadedInvoices = invoices;
    const qboInvoices = quickBooksData.bills.map(bill => ({
      id: `qbo-${bill.id}`,
      supplier: bill.supplier,
      date: bill.date || 'Date unavailable',
      category: (bill.line_items || []).map(line => line.description).filter(Boolean).slice(0, 2).join(', ') || 'QuickBooks bill',
      amount: Number(bill.total || 0),
      status: 'QuickBooks bill',
      file: `Bill ${bill.document_number || bill.id}`,
      currency: bill.currency,
      lineItems: bill.line_items || [],
    }));
    invoices = [...qboInvoices, ...uploadedInvoices];
    const sourceAlerts = quickBooksData.price_changes.map((change, index) => ({
      id: `qbo-observation-${index}`,
      type: 'supplier',
      title: `${change.supplier}: ${change.item} price changed`,
      detail: `${change.previous_unit_price} → ${change.unit_price} ${change.currency} (${change.change_percent > 0 ? '+' : ''}${change.change_percent}%). ${change.evidence}.`,
      time: change.date || 'QuickBooks history',
      read: true,
      apiKind: 'quickbooks_observation',
    }));
    alerts = [...alerts.filter(alert => alert.apiKind !== 'quickbooks_observation'), ...sourceAlerts];
  }

  async function refreshBackendRecords() {
    const [, health] = await Promise.all([
      backendLoadLiveData(),
      pwApi('/api/health'),
    ]);
    negotiations = loadNegotiations();
    providerHealth = health;
    lastClientRefreshAt = Date.now();
    renderAll();
  }

  pwLoadLiveData = async function () {
    const [, status, health] = await Promise.all([
      backendLoadLiveData(),
      pwApi('/api/integrations/quickbooks/status'),
      pwApi('/api/health'),
    ]);
    negotiations = loadNegotiations();
    lastClientRefreshAt = Date.now();
    quickBooksStatus = status;
    providerHealth = health;
    quickBooksData = status.connected ? await pwApi('/api/integrations/quickbooks/dashboard') : null;
    mapQuickBooksData();
    renderAll();
  };

  const mapsPriceLevelLabel = level => ({
    PRICE_LEVEL_FREE: 'Free',
    PRICE_LEVEL_INEXPENSIVE: 'Inexpensive',
    PRICE_LEVEL_MODERATE: 'Moderate',
    PRICE_LEVEL_EXPENSIVE: 'Expensive',
    PRICE_LEVEL_VERY_EXPENSIVE: 'Very expensive',
  })[level] || '';

  function renderLiveCompetitors() {
    const body = $('#competitorRows');
    if (!body) return;
    const query = ($('#competitorSearch')?.value || '').trim().toLowerCase();
    const filter = $('#competitorFilter')?.value || 'all';
    const filtered = competitors.filter(item => {
      const matchesQuery = `${item.item} ${item.competitor} ${item.category}`.toLowerCase().includes(query);
      const position = item.lastPrice === null || item.lastPrice === undefined
        ? 'unobserved'
        : competitorPosition(item);
      return matchesQuery && (filter === 'all' || filter === position);
    });
    body.innerHTML = filtered.map(item => {
      const level = mapsPriceLevelLabel(item.googlePriceLevel);
      const priceNote = level
        ? `<small>Google Maps business price level: ${esc(level)} (estimate)</small>`
        : '';
      let mapsUri = null;
      try {
        const parsedMapsUri = new URL(item.googleMapsUri);
        if (parsedMapsUri.protocol === 'https:') mapsUri = parsedMapsUri.href;
      } catch {
        mapsUri = null;
      }
      const mapsLink = mapsUri
        ? `<a href="${esc(mapsUri)}" target="_blank" rel="noopener noreferrer">Maps</a>`
        : '';
      const competitorPrice = item.lastPrice === null || item.lastPrice === undefined
        ? '—'
        : formatMoney(item.lastPrice, item.currency);
      const difference = item.lastPrice === null || item.lastPrice === undefined
        ? '—'
        : `${item.lastPrice < item.mine ? '−' : item.lastPrice > item.mine ? '+' : ''}${formatMoney(Math.abs(item.lastPrice - item.mine), item.currency)}`;
      return `
        <tr>
          <td><b>${esc(item.item)}</b></td>
          <td><b>${esc(item.competitor)}</b><br>${priceNote}${mapsLink}</td>
          <td>${formatMoney(item.mine, item.currency)}</td>
          <td>${competitorPrice}</td>
          <td>${difference}</td>
          <td>${esc(item.checked || 'Not scanned')}</td>
          <td><button class="btn small" type="button" data-scan-competitor="${item.id}">Scan now</button></td>
        </tr>`;
    }).join('') || '<tr><td colspan="7" class="empty">No monitored competitors match this filter.</td></tr>';
    const count = $('#competitorCount');
    if (count) count.textContent = `${competitors.length} tracked item${competitors.length === 1 ? '' : 's'}`;
    body.querySelectorAll('[data-scan-competitor]').forEach(button => {
      button.addEventListener('click', async () => {
        const id = button.getAttribute('data-scan-competitor');
        button.disabled = true;
        try {
          const result = await pwApi(`/api/competitors/${id}/scan`, { method: 'POST' });
          await refreshBackendRecords();
          toast(result.status === 'price_found'
            ? `Website price scanned: ${formatMoney(result.price, result.currency)}.`
            : result.message || 'No reliable website price was found.');
          if (result.google_maps_warning) toast(`Google Maps refresh failed: ${result.google_maps_warning}`);
        } catch (error) {
          toast(`Price scan failed: ${error.message}`);
        } finally {
          button.disabled = false;
        }
      });
    });
  }

  renderCompetitors = renderLiveCompetitors;

  function formatMoney(value, currency) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    try {
      return new Intl.NumberFormat(selectedLocale, {
        style: 'currency',
        currency: /^[A-Z]{3}$/.test(currency || '') ? currency : 'USD',
        maximumFractionDigits: 0,
      }).format(Number(value));
    } catch {
      return `${Number(value).toFixed(2)} ${currency || ''}`.trim();
    }
  }

  function renderSupplierRows() {
    const body = $('#supplierRows');
    if (!body) return;
    body.innerHTML = suppliers.map(vendor => `
      <tr>
        <td><b>${esc(vendor.name)}</b></td><td>QuickBooks vendor</td>
        <td>Live source</td><td>—</td><td>${tag(vendor.status, vendor.status === 'Active' ? '' : 'warn')}</td>
        <td><span class="tag">Read only</span></td>
      </tr>
    `).join('') || `<tr><td colspan="6"><div class="empty">${quickBooksStatus?.connected ? 'No vendors were returned by QuickBooks.' : 'Connect QuickBooks to load the live supplier directory.'}</div></td></tr>`;
  }

  function renderProductRows() {
    const body = $('#productRows');
    if (!body) return;
    body.innerHTML = quickBooksItems.map(item => `
      <tr>
        <td><div class="product"><span class="product-emoji">▣</span><div><b>${esc(item.name)}</b><small>${esc(item.description || '')}</small></div></div></td>
        <td>${esc(item.type || 'QuickBooks item')}</td>
        <td>${formatMoney(item.unit_price, item.currency)}</td>
        <td>Not monitored</td><td>—</td><td><span class="tag">QuickBooks catalog</span></td>
      </tr>
    `).join('') || `<tr><td colspan="6"><div class="empty">${quickBooksStatus?.connected ? 'No active items were returned by QuickBooks.' : 'Connect QuickBooks to load live products and services.'}</div></td></tr>`;
  }

  function renderAnalyticsRows() {
    const page = $('#page-analytics');
    const note = page?.querySelector('.notice');
    if (note) note.textContent = 'Live QuickBooks financial report and bill history. Savings are not estimated; only recorded, verified outcomes are shown.';
    const charts = page?.querySelectorAll('.chart-area') || [];
    if (!quickBooksData) {
      if (charts[0]) charts[0].innerHTML = '<div class="empty">Connect QuickBooks to load live financial and bill-history data.</div>';
      if (charts[1]) charts[1].innerHTML = '<div class="empty">No verified savings are available.</div>';
      return;
    }
    if (charts[0]) {
      charts[0].innerHTML = quickBooksData.price_changes.length
        ? `<div class="mini-list">${quickBooksData.price_changes.slice(0, 12).map(change => `<div class="mini-row"><div class="mini-info"><b>${esc(change.supplier)} · ${esc(change.item)}</b><small>${esc(change.evidence)} · ${esc(change.date || '')}</small></div><div class="mini-value">${Number(change.change_percent) > 0 ? '+' : ''}${esc(change.change_percent)}%</div></div>`).join('')}</div>`
        : '<div class="empty">No comparable QuickBooks bill line items are available yet. Price movements require matching supplier and item descriptions across bills.</div>';
    }
    if (charts[1]) charts[1].innerHTML = '<div class="empty">No verified savings have been recorded. COMPSUO will not estimate savings from incomplete purchasing data.</div>';
  }

  function renderFinancialSummary() {
    const kpis = $('#page-dashboard .grid.kpis');
    if (!kpis) return;
    let summary = $('#pwQboFinancialSummary');
    if (!summary) {
      summary = document.createElement('section');
      summary.id = 'pwQboFinancialSummary';
      summary.className = 'card';
      summary.style.cssText = 'margin:0 0 18px;padding:18px';
      kpis.insertAdjacentElement('afterend', summary);
    }
    if (!quickBooksData) {
      summary.innerHTML = '<div class="card-head"><div><h2>QuickBooks financial summary</h2><p>Connect QuickBooks to load live report data.</p></div></div>';
      return;
    }
    const figures = [
      ['Income', quickBooksData.kpis.income],
      ['Expenses', quickBooksData.kpis.expenses],
      ['Net income', quickBooksData.kpis.net_income],
    ];
    summary.innerHTML = `
      <div class="card-head"><div><h2>QuickBooks financial summary</h2><p>${esc(quickBooksData.period.start)} to ${esc(quickBooksData.period.end)} · ${esc(quickBooksData.company_name || quickBooksData.company_id)}</p></div></div>
      <div class="grid kpis">${figures.map(([label, amount]) => `<div class="card kpi"><div><div class="kpi-label">${label}</div><div class="kpi-value">${formatMoney(amount, quickBooksData.kpis.currency)}</div><div class="kpi-note">QuickBooks Profit & Loss</div></div></div>`).join('')}</div>
    `;
  }

  function renderPurchaseOrders() {
    const page = $('#page-suppliers');
    if (!page) return;
    let card = $('#pwPurchaseOrders');
    if (!card) {
      card = document.createElement('section');
      card.id = 'pwPurchaseOrders';
      card.className = 'card';
      card.style.cssText = 'margin-top:18px';
      page.append(card);
    }
    const orders = quickBooksData?.purchase_orders || [];
    card.innerHTML = `
      <div class="card-head"><div><h2>QuickBooks purchase orders</h2><p>Read-only records from the connected company · latest ${quickBooksData?.data_limit || 0}</p></div></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>PO</th><th>Supplier</th><th>Date</th><th>Total</th><th>Status</th></tr></thead><tbody>
      ${orders.map(order => `<tr><td>${esc(order.document_number || order.id)}</td><td>${esc(order.supplier)}</td><td>${esc(order.date || '—')}</td><td>${formatMoney(order.total, order.currency)}</td><td>${esc(order.status)}</td></tr>`).join('') || `<tr><td colspan="5"><div class="empty">${quickBooksStatus?.connected ? 'No purchase orders were returned by QuickBooks.' : 'Connect QuickBooks to load purchase orders.'}</div></td></tr>`}
      </tbody></table></div>
    `;
  }

  function renderLiveSurface() {
    const connected = Boolean(PW_LIVE);
    const qboConnected = Boolean(quickBooksStatus?.connected);
    $('#page-suppliers [data-action="addSupplier"]')?.remove();
    $('#page-products [data-action="addProduct"]')?.remove();
    const count = (selector, value) => { const el = $(selector); if (el) el.textContent = String(value); };
    count('#kpiCompetitors', connected ? competitors.length : 0);
    count('#kpiChanges', connected ? alerts.length : 0);
    count('#kpiSavings', '—');
    count('#kpiActions', connected ? alerts.filter(alert => !alert.read).length : 0);
    const dashboardLabels = $('#page-dashboard .grid.kpis')?.querySelectorAll('.kpi-label') || [];
    if (dashboardLabels[1]) dashboardLabels[1].textContent = 'Recorded alerts';
    const kpiNotes = $('#page-dashboard .grid.kpis')?.querySelectorAll('.kpi-note') || [];
    if (kpiNotes[0]) kpiNotes[0].textContent = 'Live monitored URLs';
    if (kpiNotes[1]) kpiNotes[1].textContent = 'Recorded backend alerts and bill history';
    if (kpiNotes[2]) kpiNotes[2].textContent = 'No estimated savings';
    if (kpiNotes[3]) kpiNotes[3].textContent = 'Unread live alerts';

    const analyticsValues = $('#page-analytics .grid.kpis')?.querySelectorAll('.kpi-value') || [];
    if (analyticsValues.length >= 4) {
      analyticsValues[0].textContent = '—';
      analyticsValues[1].textContent = quickBooksData
        ? formatMoney(quickBooksData.kpis.expenses, quickBooksData.kpis.currency)
        : '—';
      analyticsValues[2].textContent = String((quickBooksData?.price_changes?.length || 0) + (connected ? alerts.filter(a => a.apiKind !== 'quickbooks_observation').length : 0));
      analyticsValues[3].textContent = 'Not recorded';
      const labels = $('#page-analytics .grid.kpis')?.querySelectorAll('.kpi-label') || [];
      const notes = $('#page-analytics .grid.kpis')?.querySelectorAll('.kpi-note') || [];
      if (labels[0]) labels[0].textContent = 'Verified savings';
      if (labels[1]) labels[1].textContent = 'Month expenses';
      if (labels[2]) labels[2].textContent = 'Recorded price changes';
      if (labels[3]) labels[3].textContent = 'Savings confirmed';
      if (notes[1]) notes[1].textContent = quickBooksData ? `QuickBooks Profit & Loss · ${quickBooksData.period.start} to ${quickBooksData.period.end}` : 'Connect QuickBooks to load real financial data';
      if (notes[0]) notes[0].textContent = 'No estimated values';
      if (notes[3]) notes[3].textContent = 'No confirmed outcomes recorded';
    }

    const dashboardCharts = $('#page-dashboard')?.querySelectorAll('.chart-card .chart-area') || [];
    dashboardCharts.forEach((chart, index) => {
      chart.innerHTML = `<div class="empty">${index === 0
        ? 'Price history will appear after competitor website scans record verified prices.'
        : 'Supplier price movements will appear when comparable live invoice records are available.'}</div>`;
    });
    const dashboardChartHeadings = $('#page-dashboard')?.querySelectorAll('.chart-card .card-head h2') || [];
    if (dashboardChartHeadings[0]) dashboardChartHeadings[0].textContent = 'Price position overview';
    if (dashboardChartHeadings[1]) dashboardChartHeadings[1].textContent = 'Competitor price history';
    const dashboardChartDescriptions = $('#page-dashboard')?.querySelectorAll('.chart-card .card-head p') || [];
    if (dashboardChartDescriptions[1]) dashboardChartDescriptions[1].textContent = 'Recorded website prices only.';
    const position = $('#page-dashboard .donut-row');
    if (position) {
      const observed = competitors.filter(item => item.liveRecord && item.lastPrice !== null);
      const cheaper = observed.filter(item => competitorPosition(item) === 'lower').length;
      const similar = observed.filter(item => competitorPosition(item) === 'similar').length;
      const moreExpensive = observed.filter(item => competitorPosition(item) === 'higher').length;
      position.innerHTML = `<div class="donut"><div class="donut-center">${observed.length}<small>Observed</small></div></div><div class="legend"><div>Competitor cheaper <b>${cheaper}</b></div><div>Similar <b>${similar}</b></div><div>You are cheaper <b>${moreExpensive}</b></div></div>`;
    }
    const supplierAlerts = $('#dashSupplierAlerts');
    if (supplierAlerts) {
      const movements = quickBooksData?.price_changes?.filter(change => Number(change.change_percent) > 0) || [];
      const backendAlerts = alerts.filter(alert => alert.apiKind !== 'quickbooks_observation' && alert.type === 'supplier');
      supplierAlerts.innerHTML = [...backendAlerts.map(alert => `<div class="mini-row"><div class="mini-info"><b>${esc(alert.title)}</b><small>${esc(alert.detail)}</small></div></div>`), ...movements.slice(0, 5).map(change => `<div class="mini-row"><div class="mini-info"><b>${esc(change.supplier)} · ${esc(change.item)}</b><small>${esc(change.evidence)}</small></div><div class="mini-value red">+${esc(change.change_percent)}%</div></div>`)].join('') || '<div class="empty">No verified supplier price increases were found in live records.</div>';
    }
    const savingRows = $('#dashSavings');
    if (savingRows) savingRows.innerHTML = '<div class="empty">No verified savings recorded. Estimates are intentionally disabled.</div>';

    const briefing = $('#page-dashboard .briefing');
    if (briefing) {
      briefing.innerHTML = `<h2>Live data status</h2><p>${connected ? `${competitors.length} monitored competitor(s), ${invoices.length} supplier bill/invoice record(s), and ${alerts.length} alert(s) loaded from the backend.` : 'No backend data is available.'} ${qboConnected ? `QuickBooks ${quickBooksData.environment} report period: ${quickBooksData.period.start}–${quickBooksData.period.end}.` : 'Connect QuickBooks to load financial reports, vendors, items, bills, and purchase orders.'}</p>`;
    }
    const settingsNote = $('#page-settings .notice');
    if (settingsNote) settingsNote.textContent = 'Live mode only. Individual accounts and roles protect this shared workspace; provider tokens remain server-side and encrypted.';
    const settingsTitle = $('#page-settings .pagehead p');
    if (settingsTitle) settingsTitle.textContent = 'Connect live business data sources and manage the private workspace.';
    const statusRows = $('#page-settings .card')?.querySelectorAll('.mini-row') || [];
    if (statusRows[0]) statusRows[0].querySelector('.tag').textContent = connected ? 'Live' : 'Unavailable';
    if (statusRows[1]) statusRows[1].querySelector('.tag').textContent = connected ? 'Live' : 'Unavailable';
    if (statusRows[2]) {
      statusRows[2].querySelector('b').textContent = 'QuickBooks Online';
      statusRows[2].querySelector('small').textContent = qboConnected ? `Connected in ${quickBooksData.environment} mode · read-only API calls.` : 'Not connected. Configure OAuth in Render, then connect a company.';
      statusRows[2].querySelector('.tag').textContent = qboConnected ? 'Live' : 'Not connected';
    }
    renderSupplierRows();
    renderProductRows();
    renderAnalyticsRows();
    renderFinancialSummary();
    renderPurchaseOrders();
    const productNote = $('#page-products .card-head p');
    if (productNote) productNote.textContent = qboConnected ? 'Read-only active products and services from QuickBooks Online.' : 'Connect QuickBooks to load live products and services.';
  }

  originalRenderAll = renderAll;
  renderAll = function () {
    originalRenderAll();
    renderLiveSurface();
  };

  function ensureQuickBooksControls() {
    const card = $('#page-settings .card');
    if (!card || $('#pwQuickBooksControls')) return;
    card.insertAdjacentHTML('beforeend', `
      <hr style="border:0;border-top:1px solid var(--line);margin:22px 0">
      <section id="pwQuickBooksControls">
        <h3>QuickBooks Online</h3>
        <p id="pwQuickBooksStatus" style="font-size:12px;color:var(--muted)">Checking connection…</p>
        <button class="btn primary" id="pwQuickBooksConnect">Connect QuickBooks</button>
        <button class="btn" id="pwQuickBooksDisconnect" hidden>Disconnect</button>
        <p style="font-size:11px;color:var(--muted)">COMPSUO reads financial reports, vendors, items, bills, and purchase orders. It does not write to QuickBooks.</p>
      </section>
    `);
    $('#pwQuickBooksConnect').onclick = async () => {
      try {
        const result = await pwApi('/api/integrations/quickbooks/connect');
        location.assign(result.authorization_url);
      } catch (error) {
        toast(`QuickBooks connection could not start: ${error.message}`);
      }
    };
    $('#pwQuickBooksDisconnect').onclick = async () => {
      if (!confirm('Disconnect the QuickBooks company?')) return;
      try {
        await pwApi('/api/integrations/quickbooks/connection', { method: 'DELETE' });
        await pwLoadLiveData();
      } catch (error) {
        toast(`QuickBooks disconnect failed: ${error.message}`);
      }
    };
  }

  function updateQuickBooksControls() {
    ensureQuickBooksControls();
    const status = $('#pwQuickBooksStatus');
    const connect = $('#pwQuickBooksConnect');
    const disconnect = $('#pwQuickBooksDisconnect');
    if (!status || !connect || !disconnect) return;
    status.textContent = quickBooksStatus?.connected
      ? `Connected to company ${quickBooksStatus.company_id} · ${quickBooksStatus.environment}`
      : quickBooksStatus?.configured
        ? `Not connected · OAuth configured for ${quickBooksStatus.environment}`
        : 'OAuth client credentials are not configured on the backend.';
    connect.hidden = Boolean(quickBooksStatus?.connected);
    disconnect.hidden = !quickBooksStatus?.connected;
  }

  function ensureGoogleMapsControls() {
    const card = $('#page-settings .card');
    if (!card || $('#pwGoogleMapsControls')) return;
    const section = document.createElement('section');
    section.id = 'pwGoogleMapsControls';
    section.style.cssText = 'margin-top:20px;padding-top:16px;border-top:1px solid var(--line)';
    section.innerHTML = `
      <h3>Google Maps price levels</h3>
      <p id="pwGoogleMapsStatus" style="font-size:12px;color:var(--muted)">Checking provider configuration…</p>
      <p style="font-size:11px;color:var(--muted)">Google Maps provides an approximate business-level price category, not exact product prices. Exact product prices are scanned from the public website URL you monitor.</p>
    `;
    card.append(section);
  }

  function updateGoogleMapsControls() {
    ensureGoogleMapsControls();
    const status = $('#pwGoogleMapsStatus');
    if (!status) return;
    status.textContent = providerHealth?.google_places_configured
      ? 'Google Places is configured. Saved place details and website prices refresh every 15 minutes.'
      : 'Google Places is not configured. Add GOOGLE_MAPS_API_KEY to the backend environment, enable Places API (New), and restart the API.';
  }

  const oldRender = renderAll;
  renderAll = function () {
    oldRender();
    updateQuickBooksControls();
    updateGoogleMapsControls();
  };

  originalEditNegotiation = editNegotiation;
  editNegotiation = function (id) {
    originalEditNegotiation(id);
    const saveButton = $('#pwSaveNegotiation');
    if (!saveButton) return;
    saveButton.onclick = () => {
      const existing = negotiations.find(item => item.id === id) || {};
      const draft = {
        ...existing,
        id: existing.id || `local-${Date.now()}`,
        supplier: $('#negSupplier').value.trim(),
        topic: $('#negTopic').value.trim(),
        body: $('#negBody').value,
        status: existing.status || 'Draft',
        benefit: existing.benefit || 0,
      };
      negotiations = [...negotiations.filter(item => item.id !== existing.id), draft];
      localStorage.setItem('compsuoNegotiations', JSON.stringify(negotiations));
      closeModal();
      renderAll();
      toast('Negotiation draft saved in this browser only.');
    };
  };

  originalReadAlert = readAlert;
  readAlert = async function (id) {
    if (String(id).startsWith('qbo-observation-')) {
      toast('Price observation is read-only and sourced from QuickBooks bill history.');
      return;
    }
    if (!PW_LIVE) {
      toast('Connect to the live backend to update alert status.');
      return;
    }
    return originalReadAlert(id);
  };

  reviewCompetitor = function (id) {
    if (!PW_LIVE) return toast('Connect to the live backend before scanning a competitor.');
    const scanButton = document.querySelector(`[data-scan-competitor="${id}"]`);
    if (scanButton) return scanButton.click();
    return toast('Open the competitor list to scan this website.');
  };
  addCompetitor = function () {
    if (!PW_LIVE) return toast('Connect to the live backend before adding a competitor.');
    openModal('Add monitored competitor', `
      <form id="pwAddCompetitorForm" class="form-grid">
        <div class="field" style="grid-column:1/-1">
          <label for="pwPlaceQuery">Find a business in Google Maps</label>
          <div style="display:flex;gap:8px">
            <input id="pwPlaceQuery" placeholder="Business name and location" maxlength="250">
            <button class="btn" type="button" id="pwPlaceSearch">Search</button>
          </div>
          <p id="pwMapsSearchMessage" role="status" style="font-size:11px;color:var(--muted)"></p>
          <div id="pwPlaceResults" class="mini-list"></div>
        </div>
        <div class="field"><label for="pwCompetitorName">Competitor name</label><input id="pwCompetitorName" required maxlength="200"></div>
        <div class="field"><label for="pwProductName">Product or service</label><input id="pwProductName" required maxlength="300" placeholder="Exact product or service"></div>
        <div class="field" style="grid-column:1/-1"><label for="pwCompetitorUrl">Public page with the exact price</label><input id="pwCompetitorUrl" type="url" required placeholder="https://example.com/product"></div>
        <div class="field"><label for="pwTargetPrice">Your reference price</label><input id="pwTargetPrice" type="number" min="0" step="any" required></div>
        <div class="field"><label for="pwCurrency">Currency code</label><input id="pwCurrency" value="USD" maxlength="8" required></div>
      </form>
      <p style="font-size:11px;color:var(--muted)">Google Maps price levels are approximate business-level estimates. Exact item prices come only from the public price page above.</p>
    `, `
      <button class="btn" type="button" onclick="closeModal()">Cancel</button>
      <button class="btn primary" type="button" id="pwSaveCompetitor">Add competitor</button>
    `);
    const form = $('#pwAddCompetitorForm');
    const resultContainer = $('#pwPlaceResults');
    $('#pwPlaceSearch').addEventListener('click', async () => {
      const query = $('#pwPlaceQuery').value.trim();
      const message = $('#pwMapsSearchMessage');
      if (query.length < 2) {
        message.textContent = 'Enter a business name and location.';
        return;
      }
      form.dataset.googlePlaceId = '';
      message.textContent = 'Searching Google Maps…';
      resultContainer.innerHTML = '';
      try {
        const response = await pwApi('/api/places/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        });
        const places = response.places || [];
        message.textContent = places.length
          ? 'Choose a business. Maps price levels are estimates, not product prices.'
          : 'No matching places were found.';
        resultContainer.innerHTML = places.map((place, index) => {
          const name = place.displayName?.text || 'Unnamed place';
          const level = mapsPriceLevelLabel(place.priceLevel) || 'Not provided';
          return `
            <button class="mini-row" type="button" data-place-index="${index}" style="width:100%;border:0;background:#fff;text-align:left">
              <span class="mini-info"><b>${esc(name)}</b><small>${esc(place.formattedAddress || '')} · Maps price level: ${esc(level)} (estimate)</small></span>
            </button>`;
        }).join('');
        resultContainer.querySelectorAll('[data-place-index]').forEach(button => {
          button.addEventListener('click', () => {
            const place = places[Number(button.getAttribute('data-place-index'))];
            form.dataset.googlePlaceId = place.id;
            $('#pwCompetitorName').value = place.displayName?.text || '';
            if (place.websiteUri) $('#pwCompetitorUrl').value = place.websiteUri;
            message.textContent = place.websiteUri
              ? `Selected ${place.displayName?.text || 'place'}. Use a specific product or service URL for exact price scans.`
              : 'Selected place has no website. Enter a public product or service price page manually.';
          });
        });
      } catch (error) {
        message.textContent = `Google Maps search failed: ${error.message}`;
      }
    });
    $('#pwSaveCompetitor').addEventListener('click', saveNewCompetitor);
  };
  const previousUploadInvoice = uploadInvoice;
  uploadInvoice = function () {
    if (!PW_LIVE) return toast('Connect to the live backend before uploading an invoice.');
    return previousUploadInvoice();
  };
  saveNewCompetitor = async function () {
    if (!PW_LIVE) return toast('Connect to the live backend before saving a competitor.');
    const name = $('#pwCompetitorName')?.value.trim();
    const product = $('#pwProductName')?.value.trim();
    const url = $('#pwCompetitorUrl')?.value.trim();
    const price = Number($('#pwTargetPrice')?.value);
    const currency = $('#pwCurrency')?.value.trim().toUpperCase();
    if (!name || !product || !url || !Number.isFinite(price) || price < 0 || !currency) {
      toast('Enter a competitor, product or service, public price page, reference price, and currency.');
      return;
    }
    try {
      new URL(url);
    } catch {
      toast('Enter a valid public website URL.');
      return;
    }
    const form = $('#pwAddCompetitorForm');
    const selectedPlaceId = form?.dataset.googlePlaceId || null;
    const saveButton = $('#pwSaveCompetitor');
    saveButton.disabled = true;
    try {
      await pwApi('/api/competitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          product_or_service: product,
          url,
          target_price: price,
          currency,
          google_place_id: selectedPlaceId,
        }),
      });
      closeModal();
      await pwLoadLiveData();
      toast('Competitor added. Run a website scan or wait for the next automatic refresh.');
    } catch (error) {
      toast(`Could not add competitor: ${error.message}`);
    } finally {
      saveButton.disabled = false;
    }
  };

  function installCsvExport() {
    const button = $('#exportReport');
    if (!button) return;
    button.onclick = () => {
      if (!quickBooksData) {
        toast('Connect QuickBooks to export live financial reports.');
        return;
      }
      const rows = [
        ['Metric', 'Value', 'Currency', 'Period'],
        ['Income', quickBooksData.kpis.income ?? '', quickBooksData.kpis.currency, `${quickBooksData.period.start} to ${quickBooksData.period.end}`],
        ['Expenses', quickBooksData.kpis.expenses ?? '', quickBooksData.kpis.currency, `${quickBooksData.period.start} to ${quickBooksData.period.end}`],
        ['Net income', quickBooksData.kpis.net_income ?? '', quickBooksData.kpis.currency, `${quickBooksData.period.start} to ${quickBooksData.period.end}`],
        ['Verified savings', '', quickBooksData.kpis.currency, 'No verified savings recorded'],
      ];
      const csv = rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `compsuo-${quickBooksData.period.end}.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
  }

  $('#pwAuthForm').addEventListener('submit', signIn);
  $('#pwAuthSwitch').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
  const signOutButton = document.createElement('button');
  signOutButton.className = 'btn';
  signOutButton.type = 'button';
  signOutButton.textContent = 'Sign out';
  signOutButton.addEventListener('click', async () => {
    try {
      await pwApi('/api/auth/logout', { method: 'POST' });
      currentUser = null;
      setEmptyWorkspace();
      PW_LIVE = false;
      showGate('You have signed out.');
      renderAll();
    } catch (error) {
      toast(`Could not sign out: ${error.message}`);
    }
  });
  $('.top-right')?.append(signOutButton);
  $('#saveSettings').onclick = async () => {
    const name = $('#settingBusiness').value.trim();
    const base = pwSecureApiBase($('#settingApiBase').value);
    if (!base) return toast('Enter a backend API URL.');
    if (name) $('#businessSelect').options[0].text = name;
    PW_API_BASE = base;
    localStorage.setItem('compsuoApiBase', base);
    $('#settingApiBase').value = base;
    await boot();
  };
  $('#dateButton').onclick = () => toast(quickBooksData
    ? `Live QuickBooks and backend data loaded for ${quickBooksData.period.start} to ${quickBooksData.period.end}.`
    : 'Dashboard is showing only live backend records; connect QuickBooks for financial reports.');
  installCsvExport();

  async function boot() {
    $('#settingApiBase').value = PW_API_BASE;
    try {
      const session = await pwApi('/api/auth/session');
      if (!session.authenticated) {
        currentUser = null;
        setEmptyWorkspace();
        PW_LIVE = false;
        showGate('Sign in with your account, or create one if you are new to this workspace.');
        renderAll();
        return;
      }
      currentUser = session.user;
      setIdentity();
      hideGate();
      await pwLoadLiveData();
      pwStatus('Live backend connected. Figures come from saved records and configured data providers; verify source documents before acting.', true);
      updateQuickBooksControls();
      renderAll();
      refreshLocalePreferences();
      await renderAdminPanel();
    } catch (error) {
      PW_LIVE = false;
      setEmptyWorkspace();
      setAuthMode('login');
      pwStatus(`Live backend unavailable: ${error.message}`, false);
      showGate(`Backend unavailable: ${error.message}. Check its deployment and API URL.`);
      renderAll();
    }
  }

  const query = new URLSearchParams(location.search);
  if (query.has('quickbooks')) {
    const result = query.get('quickbooks');
    if (result === 'connected') toast('QuickBooks connected. Loading live data…');
    else if (result === 'company_mismatch') toast('A different QuickBooks company is already connected. Disconnect it before switching companies.');
    else if (result === 'denied') toast('QuickBooks connection was cancelled.');
    history.replaceState(null, '', location.pathname);
  }

  setEmptyWorkspace();
  renderAll();
  boot();
  async function automaticRefresh() {
    if (!document.body.classList.contains('pw-authenticated') || clientRefreshInProgress) return;
    clientRefreshInProgress = true;
    try {
      await refreshBackendRecords();
      pwStatus(`Live records refreshed at ${new Date(lastClientRefreshAt).toLocaleTimeString()}.`, true);
    } catch (error) {
      pwStatus(`Automatic refresh failed: ${error.message}`, false);
    } finally {
      clientRefreshInProgress = false;
    }
  }
  setInterval(automaticRefresh, 15 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastClientRefreshAt >= 15 * 60 * 1000) {
      automaticRefresh();
    }
  });
  setInterval(() => {
    if (document.body.classList.contains('pw-authenticated')) refreshLocalePreferences();
  }, 6 * 60 * 60 * 1000);
})();
