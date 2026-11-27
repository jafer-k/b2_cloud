async function uploadToB2({ video_cdn, file_key, image_cdn, apiKey }) {
  const response = await fetch("https://b2cloud-ten.vercel.app/api/cdn-to-b2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({ video_cdn, file_key, image_cdn }),
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
        video_cdn: row.video_cdn,
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

// API key entered by the user in the frontend.
const apiKey = document.querySelector("#api-key").value;
const results = await uploadAll(rows, apiKey);
console.log(results);
