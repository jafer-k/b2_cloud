const b2CloudUpsert = (function () {
  'use strict';

  const INSERT_COLS = [
    'user_id', 'file_key', 'WhoCanView', 'likes',
    'date_posted', 'video_cdn', 'image_cdn',
  ];

  const UPDATABLE_COLS = ['likes', 'WhoCanView', 'video_cdn', 'image_cdn'];

  function insertParams(row) {
    return [
      row.user_id     ?? null,
      row.file_key,
      row.WhoCanView  ?? null,
      Number(row.likes) || 0,
      row.date_posted ?? null,
      row.video_cdn   ?? null,
      row.image_cdn   ?? null,
    ];
  }

  function buildInsert(rowCount) {
    const rowPh = '(' + INSERT_COLS.map(() => '?').join(', ') + ')';
    const values = Array(rowCount).fill(rowPh).join(', ');
    const cols   = INSERT_COLS.map(c => `"${c}"`).join(', ');
    return `INSERT INTO "b2_cloud" (${cols}) VALUES ${values}
ON CONFLICT("file_key") DO NOTHING;`;
  }

  function checkQuery(query) { return typeof query === 'function'; }

  function reportChanges(result) {
    return (result && typeof result.changes === 'number') ? result.changes : undefined;
  }

  function validatePatch(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch))
      return { ok: false, reason: 'patch must be a plain object' };
    const keys = Object.keys(patch);
    if (keys.length === 0) return { ok: false, reason: 'patch is empty' };
    const bad = keys.filter(k => !UPDATABLE_COLS.includes(k));
    if (bad.length) return { ok: false, reason: 'invalid column(s): ' + bad.join(', ') };
    return { ok: true, keys };
  }

  async function upsertOne(query, row) {
    if (!checkQuery(query))
      return { ok: false, file_key: row && row.file_key,
               error: new Error('query must be a function') };
    if (!row || !row.file_key)
      return { ok: false, file_key: row && row.file_key,
               error: new Error('row has no file_key') };
    try {
      const result = await query(buildInsert(1), insertParams(row));
      return { ok: true, file_key: row.file_key,
               changes: reportChanges(result), result };
    } catch (error) {
      return { ok: false, file_key: row.file_key, error };
    }
  }

  async function upsertMany(query, rows, options) {
    if (!checkQuery(query))
      return { ok: false, submitted: 0, changes: 0, skipped: 0,
               total: Array.isArray(rows) ? rows.length : 0,
               errors: [{ error: new Error('query must be a function') }] };

    const opts      = options || {};
    const chunkSize = Math.max(1, Math.min(opts.chunkSize || 100, 200));
    const list      = Array.isArray(rows) ? rows : [];
    const valid     = list.filter(r => r && r.file_key);
    const skipped   = list.length - valid.length;

    let submitted = 0, changes = 0;
    const errors = [];

    for (let i = 0; i < valid.length; i += chunkSize) {
      const chunk = valid.slice(i, i + chunkSize);
      try {
        const result = await query(buildInsert(chunk.length),
                                   chunk.flatMap(insertParams));
        submitted += chunk.length;
        const c = reportChanges(result);
        if (typeof c === 'number') changes += c;
      } catch {
        for (const row of chunk) {
          const r = await upsertOne(query, row);
          if (r.ok) {
            submitted++;
            if (typeof r.changes === 'number') changes += r.changes;
          } else {
            errors.push({ file_key: row.file_key, error: r.error });
          }
        }
      }
    }

    return {
      ok: errors.length === 0,
      submitted, changes, skipped,
      total: list.length, errors,
    };
  }

  async function updateOne(query, fileKey, patch) {
    if (!checkQuery(query) || !fileKey)
      return { ok: false, file_key: fileKey, error: new Error('bad args') };
    const v = validatePatch(patch);
    if (!v.ok) return { ok: false, file_key: fileKey, error: new Error(v.reason) };
    const setClause = v.keys.map(c => `"${c}" = ?`).join(', ');
    const sql = `UPDATE "b2_cloud" SET ${setClause} WHERE "file_key" = ?`;
    const params = v.keys.map(c => patch[c]).concat(fileKey);
    try {
      const result = await query(sql, params);
      return { ok: true, file_key: fileKey,
               changes: reportChanges(result), result };
    } catch (error) {
      return { ok: false, file_key: fileKey, error };
    }
  }

  async function updateField(query, fileKey, column, value) {
    if (!checkQuery(query) || !fileKey)
      return { ok: false, file_key: fileKey, error: new Error('bad args') };
    if (!UPDATABLE_COLS.includes(column))
      return { ok: false, file_key: fileKey,
               error: new Error('invalid column: ' + column) };
    const sql = `UPDATE "b2_cloud" SET "${column}" = ? WHERE "file_key" = ?`;
    try {
      const result = await query(sql, [value, fileKey]);
      return { ok: true, file_key: fileKey, column,
               changes: reportChanges(result), result };
    } catch (error) {
      return { ok: false, file_key: fileKey, column, error };
    }
  }

  return { upsertOne, upsertMany, updateOne, updateField };
})();
window.b2CloudUpsert = b2CloudUpsert;
