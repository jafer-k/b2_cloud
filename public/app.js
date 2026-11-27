(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  const apiBase        = 'https://b2cloud-ten.vercel.app';
  const API_SQL_URL    = apiBase + '/api/sql';
  const API_HEALTH_URL = apiBase + '/api/health';
  const KEY_STORE      = 'b2_api_key';

  /* element refs */
  const apiKeyInput    = $('apiKeyInput');
  const keyFormArea    = $('keyFormArea');
  const keyStoredArea  = $('keyStoredArea');
  const btnSaveKey     = $('btnSaveKey');
  const btnChangeKey   = $('btnChangeKey');
  const btnForgetKey   = $('btnForgetKey');
  const btnHealth      = $('btnHealth');
  const healthOut      = $('healthOut');
  const fileInput      = $('fileInput');
  const fileBtnLabel   = $('fileBtnLabel');
  const fileBanner     = $('fileBanner');
  const fileNameEl     = $('fileName');
  const fileSizeEl     = $('fileSize');
  const btnRemoveF     = $('btnRemoveFile');
  const btnTransform   = $('btnTransform');
  const btnClearAll    = $('btnClearAll');
  const summaryPanel   = $('summaryPanel');
  const firstPanel     = $('firstPanel');
  const upsertPanel    = $('upsertPanel');
  const updatePanel    = $('updatePanel');
  const firstOut       = $('firstOut');
  const statUserId     = $('statUserId');
  const statTotal      = $('statTotal');
  const statSkipped    = $('statSkipped');
  const btnCopyFirst   = $('btnCopyFirst');
  const btnUpsertAll   = $('btnUpsertAll');
  const btnUpsertOne   = $('btnUpsertOne');
  const upsertResult   = $('upsertResult');
  const rSubmitted     = $('rSubmitted');
  const rChanges       = $('rChanges');
  const rSkipped       = $('rSkipped');
  const rTotal         = $('rTotal');
  const upsertErrors   = $('upsertErrors');
  const updateFileKey  = $('updateFileKey');
  const updateColumn   = $('updateColumn');
  const updateValue    = $('updateValue');
  const updatePatch    = $('updatePatch');
  const btnUpdateField = $('btnUpdateField');
  const btnUpdatePatch = $('btnUpdatePatch');
  const updateOut      = $('updateOut');
  const statusEl       = $('status');

  /* spinners */
  const spinners = {
    transform:   $('spinnerTransform'),
    upsertAll:   $('spinnerUpsertAll'),
    upsertOne:   $('spinnerUpsertOne'),
    updateField: $('spinnerUpdateField'),
    updatePatch: $('spinnerUpdatePatch'),
    health:      $('spinnerHealth'),
  };

  /* state */
  let loadedFile    = null;
  let rows          = null;
  let currentUserId = null;
  let working       = false;
  let currentOp     = null;

  /* ---------- API key ---------- */

  function getApiKey() {
    try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; }
  }
  function setApiKey(k) {
    try { k ? localStorage.setItem(KEY_STORE, k) : localStorage.removeItem(KEY_STORE); }
    catch {}
  }
  function refreshKeyUI() {
    const has = !!getApiKey();
    keyFormArea.classList.toggle('hidden', has);
    keyStoredArea.classList.toggle('hidden', !has);
    refreshUi();
  }

  btnSaveKey.addEventListener('click', () => {
    const k = apiKeyInput.value.trim();
    if (!k) { setStatus('Paste a key first.', 'err'); return; }
    setApiKey(k);
    apiKeyInput.value = '';
    refreshKeyUI();
    setStatus('API key saved to localStorage.', 'ok');
  });

  btnChangeKey.addEventListener('click', () => {
    keyFormArea.classList.remove('hidden');
    keyStoredArea.classList.add('hidden');
    apiKeyInput.focus();
  });

  btnForgetKey.addEventListener('click', () => {
    setApiKey('');
    apiKeyInput.value = '';
    refreshKeyUI();
    setStatus('API key removed.', '');
  });

  /* ---------- query (executor for b2CloudUpsert) ---------- */

  async function query(sql, params) {
    const key = getApiKey();
    if (!key) throw new Error('API key not set');

    const res = await fetch(API_SQL_URL, {
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

  /* ---------- UI state ---------- */

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }
  function pretty(o) {
    try { return JSON.stringify(o, null, 2); } catch { return String(o); }
  }

  function setWorking(on, op) {
    working   = !!on;
    currentOp = on ? (op || 'other') : null;
    refreshUi();
  }

  function refreshUi() {
    const hasKey  = !!getApiKey();
    const hasFile = !!loadedFile;
    const hasRows = Array.isArray(rows) && rows.length > 0;
    const busy    = working;

    /* buttons */
    btnSaveKey.disabled     = busy;
    btnChangeKey.disabled   = busy;
    btnForgetKey.disabled   = busy;
    btnHealth.disabled      = busy || !hasKey;
    btnRemoveF.disabled     = busy;
    btnClearAll.disabled    = busy;
    btnCopyFirst.disabled   = busy || !hasRows;
    btnTransform.disabled   = busy || !hasFile;
    btnUpsertAll.disabled   = busy || !hasRows || !hasKey;
    btnUpsertOne.disabled   = busy || !hasRows || !hasKey;
    btnUpdateField.disabled = busy || !hasKey;
    btnUpdatePatch.disabled = busy || !hasKey;

    /* file label */
    fileBtnLabel.style.pointerEvents = busy ? 'none' : '';
    fileBtnLabel.style.opacity       = busy ? '0.5'  : '';

    /* spinners */
    spinners.transform.classList.toggle('hidden',   currentOp !== 'transform');
    spinners.upsertAll.classList.toggle('hidden',   currentOp !== 'upsertAll');
    spinners.upsertOne.classList.toggle('hidden',   currentOp !== 'upsertOne');
    spinners.updateField.classList.toggle('hidden', currentOp !== 'updateField');
    spinners.updatePatch.classList.toggle('hidden', currentOp !== 'updatePatch');
    spinners.health.classList.toggle('hidden',      currentOp !== 'health');
  }

  function resetOutputs() {
    rows = null; currentUserId = null;
    summaryPanel.classList.add('hidden');
    firstPanel.classList.add('hidden');
    upsertPanel.classList.add('hidden');
    updatePanel.classList.add('hidden');
    upsertResult.classList.add('hidden');
    upsertErrors.classList.add('hidden');
    upsertErrors.textContent = '';
    updateOut.classList.add('hidden');
    updateOut.textContent = '';
    statUserId.textContent = '—';
    statTotal.textContent  = '—';
    statSkipped.textContent = '—';
    firstOut.textContent = '—';
    firstOut.classList.add('muted');
    refreshUi();
  }

  function refreshFileBanner() {
    if (!loadedFile) fileBanner.classList.add('hidden');
    else             fileBanner.classList.remove('hidden');
    refreshUi();
  }

  /* ---------- file load ---------- */

  fileInput.addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;

    loadedFile = f;
    fileNameEl.textContent = f.name;
    fileSizeEl.textContent = `(${f.size.toLocaleString()} bytes)`;
    refreshFileBanner();
    resetOutputs();
    setStatus(`Loaded "${f.name}". Click Transform JSON.`, 'ok');
  });

  btnRemoveF.addEventListener('click', () => {
    loadedFile = null;
    fileNameEl.textContent = '';
    fileSizeEl.textContent = '';
    refreshFileBanner();
    resetOutputs();
    setStatus('File removed.', '');
  });

  btnClearAll.addEventListener('click', () => {
    loadedFile = null;
    fileNameEl.textContent = '';
    fileSizeEl.textContent = '';
    refreshFileBanner();
    resetOutputs();
    setStatus('Cleared.', '');
  });

  /* ---------- health ---------- */

  btnHealth.addEventListener('click', async () => {
    const key = getApiKey();
    if (!key) { setStatus('Save an API key first.', 'err'); return; }

    setWorking(true, 'health');
    healthOut.classList.add('hidden');
    healthOut.textContent = '';

    try {
      setStatus('Checking database…', '');
      const res = await fetch(API_HEALTH_URL, {
        method: 'GET',
        headers: { 'X-API-Key': key },
      });
      let data = {};
      try { data = await res.json(); } catch {}
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      healthOut.textContent =
        `OK  ·  db=${data.db}  ·  table=${data.table}  ·  ` +
        `rowCount=${data.rowCount}  ·  ${data.latencyMs} ms`;
      healthOut.classList.remove('hidden');
      healthOut.style.color = 'var(--ok)';
      setStatus('Health check passed.', 'ok');
    } catch (err) {
      healthOut.textContent = 'FAILED: ' + err.message;
      healthOut.classList.remove('hidden');
      healthOut.style.color = 'var(--err)';
      setStatus('Health check failed: ' + err.message, 'err');
    } finally {
      setWorking(false);
    }
  });

  /* ---------- transform (JSON only) ---------- */

  btnTransform.addEventListener('click', async () => {
    if (!loadedFile || working) return;

    setWorking(true, 'transform');
    upsertResult.classList.add('hidden');
    upsertErrors.classList.add('hidden');
    updateOut.classList.add('hidden');

    try {
      setStatus('Reading file…', '');
      const text = await loadedFile.text();

      setStatus('Parsing JSON…', '');
      const doc = JSON.parse(text);

      setStatus('Extracting rows…', '');
      const out = tikJsonToB2.transform(doc);

      rows          = out;
      currentUserId = rows.length ? rows[0].user_id : null;

      statUserId.textContent  = currentUserId ?? '—';
      statTotal.textContent   = String(rows.length);
      statSkipped.textContent = '0';
      summaryPanel.classList.remove('hidden');

      if (rows.length === 0) {
        firstOut.textContent = 'No rows produced.';
        firstOut.classList.add('muted');
      } else {
        firstOut.textContent = pretty(rows[0]);
        firstOut.classList.remove('muted');
      }
      firstPanel.classList.remove('hidden');
      upsertPanel.classList.remove('hidden');
      updatePanel.classList.remove('hidden');

      if (rows.length > 0 && !updateFileKey.value) {
        updateFileKey.value = rows[0].file_key || '';
      }

      setStatus(`Transformed ${rows.length} row(s). Upsert/update buttons ready.`, 'ok');
    } catch (err) {
      resetOutputs();
      setStatus('Transform error: ' + err.message, 'err');
    } finally {
      setWorking(false);
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

  /* ---------- upsert: all rows ---------- */

  btnUpsertAll.addEventListener('click', async () => {
    if (!Array.isArray(rows) || rows.length === 0 || working) return;

    setWorking(true, 'upsertAll');
    upsertResult.classList.add('hidden');
    upsertErrors.classList.add('hidden');
    upsertErrors.textContent = '';
    setStatus(`Upserting ${rows.length} row(s)…`, '');

    let r;
    try {
      r = await b2CloudUpsert.upsertMany(query, rows);
    } catch (err) {
      setStatus('Upsert all failed: ' + err.message, 'err');
      setWorking(false);
      return;
    }
    setWorking(false);

    rSubmitted.textContent = String(r.submitted ?? '—');
    rChanges.textContent   = (typeof r.changes === 'number') ? String(r.changes) : 'n/a';
    rSkipped.textContent   = String(r.skipped ?? '—');
    rTotal.textContent     = String(r.total ?? '—');
    upsertResult.classList.remove('hidden');

    if (r.ok) {
      setStatus(`Upsert all complete: ${r.submitted}/${r.total} submitted, ` +
                `${r.changes} row change(s), ${r.skipped} skipped.`, 'ok');
    } else {
      const errs = (r.errors || []).map(e =>
        '  • ' + (e.file_key || '(no key)') + ': ' + (e.error && e.error.message || e.error)
      );
      upsertErrors.textContent =
        `Upsert all finished with ${r.errors.length} error(s):\n` + errs.join('\n');
      upsertErrors.classList.remove('hidden');
      setStatus(`Upsert all finished with ${r.errors.length} error(s).`, 'err');
    }
  });

  /* ---------- upsert: rows[0] ---------- */

  btnUpsertOne.addEventListener('click', async () => {
    if (!Array.isArray(rows) || rows.length === 0 || working) return;

    const row = rows[0];
    setWorking(true, 'upsertOne');
    upsertResult.classList.add('hidden');
    upsertErrors.classList.add('hidden');
    upsertErrors.textContent = '';
    setStatus(`Upserting rows[0] (file_key=${row.file_key})…`, '');

    let r;
    try {
      r = await b2CloudUpsert.upsertOne(query, row);
    } catch (err) {
      setStatus('Upsert rows[0] failed: ' + err.message, 'err');
      setWorking(false);
      return;
    }
    setWorking(false);

    if (r.ok) {
      rSubmitted.textContent = '1';
      rChanges.textContent   = (typeof r.changes === 'number') ? String(r.changes) : 'n/a';
      rSkipped.textContent   = '0';
      rTotal.textContent     = '1';
      upsertResult.classList.remove('hidden');
      setStatus(`Upserted rows[0]: ${row.file_key} (changes: ${r.changes ?? 'n/a'})`, 'ok');
    } else {
      upsertErrors.textContent = 'Upsert rows[0] failed: ' +
        (r.error && r.error.message || r.error);
      upsertErrors.classList.remove('hidden');
      upsertResult.classList.remove('hidden');
      setStatus('Upsert rows[0] failed.', 'err');
    }
  });

  /* ---------- update: single field ---------- */

  btnUpdateField.addEventListener('click', async () => {
    if (working) return;
    const fileKey = updateFileKey.value.trim();
    const column  = updateColumn.value;
    let   value   = updateValue.value;

    if (!fileKey) { setStatus('Enter a file_key first.', 'err'); return; }
    if (!value)   { setStatus('Enter a value.', 'err'); return; }

    if (column === 'likes') {
      const n = Number(value);
      if (!Number.isFinite(n)) { setStatus('likes must be a number.', 'err'); return; }
      value = n;
    }

    setWorking(true, 'updateField');
    updateOut.classList.add('hidden');
    updateOut.textContent = '';
    setStatus(`Updating ${column} on ${fileKey}…`, '');

    let r;
    try {
      r = await b2CloudUpsert.updateField(query, fileKey, column, value);
    } catch (err) {
      setWorking(false);
      showUpdateOut('Update field failed: ' + err.message, false);
      setStatus('Update field failed.', 'err');
      return;
    }
    setWorking(false);

    if (r.ok) {
      showUpdateOut(
        `OK · ${column} updated on ${fileKey} · changes=${r.changes ?? 'n/a'}`, true);
      setStatus(`Update field complete (changes: ${r.changes ?? 'n/a'}).`, 'ok');
    } else {
      showUpdateOut('Update field failed: ' +
        (r.error && r.error.message || r.error), false);
      setStatus('Update field failed.', 'err');
    }
  });

  /* ---------- update: patch ---------- */

  btnUpdatePatch.addEventListener('click', async () => {
    if (working) return;
    const fileKey = updateFileKey.value.trim();
    const raw     = updatePatch.value.trim();

    if (!fileKey) { setStatus('Enter a file_key first.', 'err'); return; }
    if (!raw)     { setStatus('Enter a JSON patch.', 'err'); return; }

    let patch;
    try {
      patch = JSON.parse(raw);
    } catch (e) {
      setStatus('Patch is not valid JSON: ' + e.message, 'err');
      return;
    }

    setWorking(true, 'updatePatch');
    updateOut.classList.add('hidden');
    updateOut.textContent = '';
    setStatus(`Updating patch on ${fileKey}…`, '');

    let r;
    try {
      r = await b2CloudUpsert.updateOne(query, fileKey, patch);
    } catch (err) {
      setWorking(false);
      showUpdateOut('Update patch failed: ' + err.message, false);
      setStatus('Update patch failed.', 'err');
      return;
    }
    setWorking(false);

    if (r.ok) {
      const cols = Object.keys(patch).join(', ');
      showUpdateOut(
        `OK · patch on ${fileKey} (${cols}) · changes=${r.changes ?? 'n/a'}`, true);
      setStatus(`Update patch complete (changes: ${r.changes ?? 'n/a'}).`, 'ok');
    } else {
      showUpdateOut('Update patch failed: ' +
        (r.error && r.error.message || r.error), false);
      setStatus('Update patch failed.', 'err');
    }
  });

  function showUpdateOut(msg, ok) {
    updateOut.textContent = msg;
    updateOut.classList.remove('hidden');
    updateOut.classList.toggle('ok',  !!ok);
    updateOut.classList.toggle('err', !ok);
  }

  /* ---------- boot ---------- */

  refreshKeyUI();
  refreshFileBanner();
  resetOutputs();
})();
