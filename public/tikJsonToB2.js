const tikJsonToB2 = (function () {
  'use strict';

  const USER_ID_PATH = ['Profile And Settings', 'Profile Info', 'ProfileMap', 'userName'];

  function parseJSON(input) {
    if (input === null || input === undefined) throw new Error('input is null or undefined');
    if (typeof input === 'object') return input;
    if (typeof input !== 'string') throw new Error('input must be a JSON string or object');
    const t = input.trim();
    if (!t) throw new Error('input is empty');
    return JSON.parse(t);
  }

  function extractVideoList(input) {
    const p = parseJSON(input);
    if (Array.isArray(p)) return p;
    const l = p && p.Post && p.Post.Posts && p.Post.Posts.VideoList;
    if (Array.isArray(l)) return l;
    throw new Error('"Post.Posts.VideoList" not found or not an array');
  }

  function sortByLikes(input) {
    return extractVideoList(input).slice().sort(
      (a, b) => (Number(b.Likes) || 0) - (Number(a.Likes) || 0)
    );
  }

  function getUserId(input) {
    let cur;
    try { cur = parseJSON(input); } catch { return null; }
    for (const key of USER_ID_PATH) {
      if (cur === null || cur === undefined) return null;
      if (typeof cur !== 'object' || Array.isArray(cur)) return null;
      if (!Object.prototype.hasOwnProperty.call(cur, key)) return null;
      cur = cur[key];
    }
    return (typeof cur === 'string' || typeof cur === 'number') ? String(cur) : null;
  }

  function dateToKeyStamp(dateStr) {
    if (typeof dateStr !== 'string') return null;
    const digits = dateStr.replace(/\D/g, '');
    return /^\d{14}$/.test(digits) ? digits : null;
  }

  function buildFileKey(userId, dateStr) {
    if (typeof userId !== 'string' || !userId) return null;
    const stamp = dateToKeyStamp(dateStr);
    return stamp === null ? null : `${userId}_${stamp}`;
  }

  function transformPost(post, userId) {
    return {
      user_id:             userId,
      file_key:            buildFileKey(userId, post.Date),
      WhoCanView:          post.WhoCanView ?? null,
      likes:               Number(post.Likes) || 0,
      date_posted:         post.Date ?? null,
      video_cdn:           post.Link ?? null,
      image_cdn:           post.CoverImage ?? null,
      b2_bucket:           null,
      video_url:           null,
      cover_url:           null,
      file_size:           null,
      status:              null,
      created_at:          null,
      image_blob_pathname: null,
      image_blob_url:      null,
    };
  }

  function transform(input, options) {
    const opts   = options || {};
    const strict = !!opts.strict;

    const userId = getUserId(input);
    if (!userId) {
      throw new Error(
        'user_id not found — expected at path ' + JSON.stringify(USER_ID_PATH)
      );
    }

    const posts = sortByLikes(input);
    const rows  = [];

    for (const post of posts) {
      const row = transformPost(post, userId);
      if (row.file_key === null) {
        if (strict) throw new Error('Invalid Date: ' + JSON.stringify(post.Date));
        continue;
      }
      rows.push(row);
    }

    return rows;
  }

  return { transform };
})();
window.tikJsonToB2 = tikJsonToB2;
