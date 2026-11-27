const CDN_API_URL = "https://b2-cloud.vercel.app/api/cdn-to-b2";

async function uploadToB2({ url, file_key, image_cdn, apiKey }) {
  const response = await fetch(CDN_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({
      url,
      file_key,
      image_cdn,
    }),
  });
  
  const result = await response.json();
  
  if (!response.ok) {
    throw new Error(result.error || `Upload failed for ${file_key}`);
  }
  
  return result;
}

async function uploadAll(rows, apiKey) {
  if (!apiKey) throw new Error("API key is required");
  
  const results = [];
  
  for (const row of rows) {
    try {
      if (!row.video_cdn || !row.file_key) {
        throw new Error("Each row needs a source video_cdn and file_key");
      }
      
      const result = await uploadToB2({
        url: row.video_cdn,
        file_key: row.file_key,
        image_cdn: row.image_cdn,
        apiKey,
      });
      
      results.push({
        file_key: row.file_key,
        success: true,
        result,
      });
    } catch (error) {
      results.push({
        file_key: row.file_key,
        success: false,
        error: error.message,
      });
    }
  }
  
  return results;
}

const apiKey = document.querySelector("#api-key").value;
const sqlResponse = await fetch("https://b2-cloud.vercel.app/api/sql", {
  headers: { "X-API-Key": apiKey },
});
if (!sqlResponse.ok) {
  throw new Error(`Unable to fetch rows: ${sqlResponse.status}`);
}
const { rows } = await sqlResponse.json();
const results = await uploadAll(rows, apiKey);
console.log(results);
