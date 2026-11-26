(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  const API_URL   = '/api/sql';                 // relative — same origin as this page
  const KEY_STORE = 'b2_api_key';

  const apiKeyInput   = $('apiKeyInput');
  const keyStatus     = $('keyStatus');
  const btnSaveKey    = $('btnSaveKey');
  const btnClearKey   = $('btnClearKey');
  const fileInput     = $('fileInput');
  const fileBanner    = $('fileBanner');
  const fileNameEl    = $('fileName');
  const fileSizeEl    = $('fileSize');
  const btnRemoveF    = $('btnRemoveFile');
  const btnTransform  = $('btnTransform');
  const btnClearAll   = $('btnClearAll');
  const summaryPanel  = $('summaryPanel');
  const firstPanel    = $('firstPanel');
  const upsertPanel   = $('upsertPanel');
  const firstOut      = $('firstOut');
  const statUserId    = $('statUserId');
  const statTotal     = $('statTotal');
  const statSkipped   = $('statSkipped');
  const btnCopyFirst  = $('btnCopyFirst');
  const btnUpsert     = $('btnUpsert');
  const upsertSpinner = $('upsertSpinner');
  const upsertResult  = $('upsertResult');
  const rSubmitted    = $('rSubmitted');
  const rChanges      = $('rChanges');
  const rSkipped      = $('rSkipped');
  const rTotal        = $('rTotal');
  const upsertErrors  = $('upsertErrors');
  const statusEl      = $('status');

  let loadedFileText = null;
  let rows           = null;
  let currentUserId  = null;
  let working        = false;

  /* ---------- API key ---------- */

  function getApiKey() {
    try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; }
  }
  function setApiKey(k) {
    try { k ? localStorage.setItem(KEY_STORE, k) : localStorage.removeItem(KEY_STORE); }
    catch {}
  }
  function refreshKeyStatus() {
    const k = getApiKey();
    if (k) {
      keyStatus.textContent = 'stored: ' + '•'.repeat(Math.min(k.length, 24));
      keyStatus.classList.add('set');
    } else {
      keyStatus.textContent = 'no key stored';
      keyStatus.classList.remove('set');
    }
    refreshUpsertButton();
  }

  btnSaveKey.addEventListener('click', () => {
    const k = apiKeyInput.value.trim();
    if (!k) { setStatus('Paste a key first.', 'err'); return; }
    setApiKey(k);
    apiKeyInput.value = '';
    refreshKeyStatus();
    setStatus('API key saved to localStorage.', 'ok');
  });

  btnClearKey.addEventListener('click', () => {
    setApiKey('');
    apiKeyInput.value = '';
    refreshKeyStatus();
    setStatus('API key removed.', '');
  });

  /* ---------- query (executor for b2CloudUpsert) ---------- */

  async function query(sql, params) {
    const key = getApiKey();
    if (!key) throw new Error('API key not set');

    const res = await fetch(API_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body:    JSON.stringify({ sql, params }),
    });

    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch {}
      throw new Error(msg);
    }
    return res.json();
  }

  /* ---------- UI helpers ---------- */

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }
  function pretty(o) {
    try { return JSON.stringify(o, null, 2); } catch { return String(o); }
  }
  function refreshTransformButton() {
    btnTransform.disabled = working || !loadedFileText;
  }
  function refreshUpsertButton() {
    const can = !working && Array.isArray(rows) && rows.length > 0 && !!getApiKey();
    btnUpsert.disabled = !can;
  }
  function setWorking(v) {
    working = v;
    refreshTransformButton();
    refreshUpsertButton();
    upsertSpinner.classList.toggle('hidden', !v);
  }

  function resetOutputs() {
    rows = null; currentUserId = null;
    summaryPanel.classList.add('hidden');
    firstPanel.classList.add('hidden');
    upsertPanel.classList.add('hidden');
    upsertResult.classList.add('hidden');
    upsertErrors.classList.add('hidden');
    upsertErrors.textContent = '';
    statUserId.textContent = '—';
    statTotal.textContent  = '—';
    statSkipped.textContent = '—';
    firstOut.textContent = '—';
    firstOut.classList.add('muted');
    btnCopyFirst.disabled = true;
    refreshUpsertButton();
  }

  function refreshFileBanner() {
    if (!loadedFileText) {
      fileBanner.classList.add('hidden');
    } else {
      fileBanner.classList.remove('hidden');
    }
    refreshTransformButton();
  }

  /* ---------- file load ---------- */

  fileInput.addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const text = await f.text();
      loadedFileText = text;
      fileNameEl.textContent = f.name;
      fileSizeEl.textContent = `(${f.size.toLocaleString()} bytes)`;
      refreshFileBanner();
      resetOutputs();
      setStatus(`Loaded "${f.name}". Click Transform.`, 'ok');
    } catch (err) {
      setStatus('File read error: ' + err.message, 'err');
    }
  });

  btnRemoveF.addEventListener('click', () => {
    loadedFileText = null;
    fileNameEl.textContent = '';
    fileSizeEl.textContent = '';
    refreshFileBanner();
    resetOutputs();
    setStatus('File removed.', '');
  });

  btnClearAll.addEventListener('click', () => {
    loadedFileText = null;
    fileNameEl.textContent = '';
    fileSizeEl.textContent = '';
    refreshFileBanner();
    resetOutputs();
    setStatus('Cleared.', '');
  });

  /* ---------- transform ---------- */

  btnTransform.addEventListener('click', () => {
    if (!loadedFileText) return;
    try {
      const doc = JSON.parse(loadedFileText);

      const out = tikJsonToB2.transform(doc);   // may throw

      rows = out;
      currentUserId = rows.length ? rows[0].user_id : null;

      statUserId.textContent  = currentUserId ?? '—';
      statTotal.textContent   = String(rows.length);
      statSkipped.textContent = '0';   // transform silently drops bad Dates
      summaryPanel.classList.remove('hidden');

      if (rows.length === 0) {
        firstOut.textContent = 'No rows produced.';
        firstOut.classList.add('muted');
        btnCopyFirst.disabled = true;
      } else {
        firstOut.textContent = pretty(rows[0]);
        firstOut.classList.remove('muted');
        btnCopyFirst.disabled = false;
      }
      firstPanel.classList.remove('hidden');
      upsertPanel.classList.remove('hidden');
      upsertResult.classList.add('hidden');
      upsertErrors.classList.add('hidden');

      refreshUpsertButton();
      setStatus(`Transformed ${rows.length} row(s). Ready to upsert.`, 'ok');
    } catch (err) {
      resetOutputs();
      setStatus('Transform error: ' + err.message, 'err');
    }
  });

  btnCopyFirst.addEventListener('click', async () => {
    if (!rows || rows.length === 0) return;
    try {
      await navigator.clipboard.writeText(pretty(rows[0]));
      setStatus('rows[0] copied to clipboard.', 'ok');
    } catch {
      setStatus('Clipboard unavailable.', 'err');
    }
  });

  /* ---------- upsert ---------- */

  btnUpsert.addEventListener('click', async () => {
    if (!Array.isArray(rows) || rows.length === 0) return;
    if (working) return;

    setWorking(true);
    upsertResult.classList.add('hidden');
    upsertErrors.classList.add('hidden');
    upsertErrors.textContent = '';
    setStatus(`Upserting ${rows.length} row(s)…`, '');

    let r;
    try {
      r = await b2CloudUpsert.upsertMany(query, rows);
    } catch (err) {
      setWorking(false);
      setStatus('Upsert failed: ' + err.message, 'err');
      return;
    }

    setWorking(false);

    rSubmitted.textContent = String(r.submitted ?? '—');
    rChanges.textContent   = (typeof r.changes === 'number') ? String(r.changes) : 'n/a';
    rSkipped.textContent   = String(r.skipped ?? '—');
    rTotal.textContent     = String(r.total ?? '—');
    upsertResult.classList.remove('hidden');

    if (r.ok) {
      setStatus(`Upsert complete: ${r.submitted}/${r.total} submitted, ` +
                `${r.changes} row change(s), ${r.skipped} skipped.`, 'ok');
    } else {
      const errs = (r.errors || []).map(e =>
        '  • ' + (e.file_key || '(no key)') + ': ' + (e.error && e.error.message || e.error)
      );
      upsertErrors.textContent =
        `Upsert finished with ${r.errors.length} error(s):\n` + errs.join('\n');
      upsertErrors.classList.remove('hidden');
      setStatus(`Upsert finished with ${r.errors.length} error(s). See details below.`, 'err');
    }
  });

  /* ---------- boot ---------- */

  refreshKeyStatus();
  refreshFileBanner();
  resetOutputs();
})();
