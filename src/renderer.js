const $ = (selector) => document.querySelector(selector);

const elements = {
  status: $('#status'),
  baseUrl: $('#baseUrl'),
  managementKey: $('#managementKey'),
  pollSeconds: $('#pollSeconds'),
  autoPoll: $('#autoPoll'),
  saveSettings: $('#saveSettings'),
  collectNow: $('#collectNow'),
  clearUsage: $('#clearUsage'),
  loadApiKeyUsage: $('#loadApiKeyUsage'),
  loadLogs: $('#loadLogs'),
  totalTokens: $('#totalTokens'),
  totalRequests: $('#totalRequests'),
  inputTokens: $('#inputTokens'),
  outputTokens: $('#outputTokens'),
  cachedTokens: $('#cachedTokens'),
  cacheRatio: $('#cacheRatio'),
  failedRequests: $('#failedRequests'),
  modelBars: $('#modelBars'),
  providerBars: $('#providerBars'),
  dayBars: $('#dayBars'),
  sourceBars: $('#sourceBars'),
  recentRows: $('#recentRows'),
  apiKeyUsage: $('#apiKeyUsage'),
  logs: $('#logs'),
};

let latestLogTimestamp = 0;

const formatNumber = (value) => new Intl.NumberFormat('tr-TR').format(value || 0);
const formatPercent = (part, total) => {
  if (!total) {
    return '0%';
  }

  return `${new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 }).format((part / total) * 100)}%`;
};

const setStatus = (message, type = 'info') => {
  elements.status.textContent = message;
  elements.status.style.color = type === 'error' ? '#fb7185' : type === 'success' ? '#86efac' : '#94a3b8';
};

const renderBars = (container, rows) => {
  container.innerHTML = '';
  const visible = rows.slice(0, 12);
  const max = Math.max(...visible.map((row) => row.total_tokens), 1);

  if (visible.length === 0) {
    container.innerHTML = '<p class="subtitle">Henüz veri yok. “Şimdi Topla” ile usage queue’dan kayıt çek.</p>';
    return;
  }

  for (const row of visible) {
    const item = document.createElement('div');
    item.className = 'bar-row';
    item.innerHTML = `
      <div class="bar-label" title="${escapeHtml(row.key)}">${escapeHtml(row.key)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (row.total_tokens / max) * 100)}%"></div></div>
      <div class="bar-value">
        <strong>${formatNumber(row.total_tokens)}</strong>
        <small>${formatNumber(row.cached_tokens)} cached · ${formatPercent(row.cached_tokens, row.total_tokens)}</small>
      </div>
    `;
    container.appendChild(item);
  }
};

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const renderRecent = (events) => {
  elements.recentRows.innerHTML = '';

  if (events.length === 0) {
    elements.recentRows.innerHTML = '<tr><td colspan="10">Henüz veri yok.</td></tr>';
    return;
  }

  for (const event of events) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${escapeHtml(new Date(event.timestamp).toLocaleString('tr-TR'))}</td>
      <td>${escapeHtml(event.provider)}</td>
      <td>${escapeHtml(event.model)}</td>
      <td class="num">${formatNumber(event.tokens.total_tokens)}</td>
      <td class="num">${formatNumber(event.tokens.input_tokens)}</td>
      <td class="num">${formatNumber(event.tokens.output_tokens)}</td>
      <td class="num">${formatNumber(event.tokens.reasoning_tokens)}</td>
      <td class="num">${formatNumber(event.tokens.cached_tokens)}</td>
      <td class="num">${formatPercent(event.tokens.cached_tokens, event.tokens.total_tokens)}</td>
      <td><span class="badge ${event.failed ? 'fail' : 'ok'}">${event.failed ? 'failed' : 'ok'}</span></td>
    `;
    elements.recentRows.appendChild(row);
  }
};

const refreshSummary = async () => {
  const summary = await window.cliproxy.getSummary();
  elements.totalTokens.textContent = formatNumber(summary.totals.total_tokens);
  elements.totalRequests.textContent = formatNumber(summary.totals.requests);
  elements.inputTokens.textContent = formatNumber(summary.totals.input_tokens);
  elements.outputTokens.textContent = formatNumber(summary.totals.output_tokens);
  elements.cachedTokens.textContent = formatNumber(summary.totals.cached_tokens);
  elements.cacheRatio.textContent = `${formatPercent(summary.totals.cached_tokens, summary.totals.total_tokens)} cache`;
  elements.failedRequests.textContent = formatNumber(summary.totals.failed);

  renderBars(elements.modelBars, summary.byModel);
  renderBars(elements.providerBars, summary.byProvider);
  renderBars(elements.dayBars, summary.byDay);
  renderBars(elements.sourceBars, summary.bySource);
  renderRecent(summary.recent);
};

const loadSettings = async () => {
  const settings = await window.cliproxy.getSettings();
  elements.baseUrl.value = settings.baseUrl;
  elements.pollSeconds.value = settings.pollSeconds;
  elements.autoPoll.checked = settings.autoPoll;
  elements.managementKey.placeholder = settings.hasManagementKey
    ? 'Kayıtlı key var; değiştirmek için yeni key yaz'
    : 'Management key';
};

elements.saveSettings.addEventListener('click', async () => {
  try {
    const current = await window.cliproxy.getSettings();
    const managementKey = elements.managementKey.value.trim();
    await window.cliproxy.saveSettings({
      baseUrl: elements.baseUrl.value.trim(),
      managementKey: managementKey || (current.hasManagementKey ? undefined : ''),
      pollSeconds: Number(elements.pollSeconds.value),
      autoPoll: elements.autoPoll.checked,
    });
    elements.managementKey.value = '';
    await loadSettings();
    setStatus('Ayarlar kaydedildi.', 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
});

elements.collectNow.addEventListener('click', async () => {
  try {
    setStatus('Usage queue okunuyor...');
    const result = await window.cliproxy.collectUsage();
    await refreshSummary();
    setStatus(`${result.collected} kayıt çekildi, toplam ${result.stored} kayıt saklanıyor.`, 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
});

elements.clearUsage.addEventListener('click', async () => {
  if (!confirm('Lokal kullanım verisi silinsin mi? CLIProxyAPI verisine dokunulmaz.')) {
    return;
  }

  await window.cliproxy.clearUsage();
  await refreshSummary();
  setStatus('Lokal kullanım verisi temizlendi.', 'success');
});

elements.loadApiKeyUsage.addEventListener('click', async () => {
  try {
    elements.apiKeyUsage.textContent = 'Yükleniyor...';
    const data = await window.cliproxy.getApiKeyUsage();
    elements.apiKeyUsage.textContent = JSON.stringify(data, null, 2);
    setStatus('API key usage yüklendi.', 'success');
  } catch (error) {
    elements.apiKeyUsage.textContent = error.message;
    setStatus(error.message, 'error');
  }
});

elements.loadLogs.addEventListener('click', async () => {
  try {
    elements.logs.textContent = 'Yükleniyor...';
    const data = await window.cliproxy.getLogs(latestLogTimestamp);
    latestLogTimestamp = data['latest-timestamp'] || latestLogTimestamp;
    elements.logs.textContent = (data.lines || []).join('\n') || 'Yeni log yok.';
    setStatus('Loglar yüklendi.', 'success');
  } catch (error) {
    elements.logs.textContent = error.message;
    setStatus(error.message, 'error');
  }
});

window.cliproxy.onUsageUpdated(() => {
  refreshSummary().catch((error) => setStatus(error.message, 'error'));
});

window.cliproxy.onCollectorError((message) => {
  setStatus(message, 'error');
});

loadSettings()
  .then(refreshSummary)
  .catch((error) => setStatus(error.message, 'error'));
