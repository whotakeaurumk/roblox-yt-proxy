// ================================================================
//   ROBLOX YOUTUBE IMAGE PROXY (Render.com + Grup Versiyonu)
//   server.js - Bu dosyayı GitHub repo'na ekle
// ================================================================

const express = require("express");
const fetch = require("node-fetch");
const FormData = require("form-data");

const app = express();

// Environment variables (Render dashboard'dan ayarla)
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY;
const ROBLOX_GROUP_ID = process.env.ROBLOX_GROUP_ID;
const SECRET_KEY = process.env.SECRET_KEY || "degistir";

// RAM cache
const imageCache = new Map();

// ================================================================
// HEALTH CHECK (Render bunu kullanır)
// ================================================================
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Roblox YT Image Proxy",
    mode: "group",
    groupId: ROBLOX_GROUP_ID ? "SET" : "MISSING",
    apiKey: ROBLOX_API_KEY ? "SET" : "MISSING",
    cached: imageCache.size
  });
});

// ================================================================
// ANA ENDPOINT: /image?url=YOUTUBE_URL&key=SECRET
// ================================================================
app.get("/image", async (req, res) => {
  try {
    const imageUrl = req.query.url;
    const key = req.query.key;

    // Güvenlik
    if (key !== SECRET_KEY) {
      return res.status(403).json({ error: "Invalid key" });
    }

    if (!imageUrl) {
      return res.status(400).json({ error: "Missing url parameter" });
    }

    // Cache kontrol
    if (imageCache.has(imageUrl)) {
      console.log("[CACHE]", imageUrl.substring(0, 50));
      return res.json(imageCache.get(imageUrl));
    }

    console.log("[DOWNLOAD]", imageUrl.substring(0, 80));

    // 1) YouTube'dan resmi indir
    const imgRes = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 10000
    });

    if (!imgRes.ok) {
      return res.status(400).json({ error: "Failed to download image", status: imgRes.status });
    }

    const imgBuffer = await imgRes.buffer();
    const contentType = imgRes.headers.get("content-type") || "image/jpeg";

    console.log("[UPLOAD] Size:", imgBuffer.length, "bytes -> Group:", ROBLOX_GROUP_ID);

    // 2) Roblox GRUBUNA yükle
    const form = new FormData();

    form.append("request", JSON.stringify({
      assetType: "Decal",
      displayName: "YTProfile_" + Date.now(),
      description: "YouTube channel profile picture",
      creationContext: {
        creator: {
          groupId: parseInt(ROBLOX_GROUP_ID)
        }
      }
    }), { contentType: "application/json" });

    form.append("fileContent", imgBuffer, {
      filename: "profile.png",
      contentType: contentType
    });

    const uploadRes = await fetch("https://apis.roblox.com/assets/v1/assets", {
      method: "POST",
      headers: {
        "x-api-key": ROBLOX_API_KEY,
        ...form.getHeaders()
      },
      body: form
    });

    let uploadData;
    const uploadText = await uploadRes.text();

    try {
      uploadData = JSON.parse(uploadText);
    } catch (e) {
      console.error("[ERROR] Bad response:", uploadText.substring(0, 200));
      return res.status(500).json({ error: "Invalid Roblox response" });
    }

    if (!uploadRes.ok) {
      console.error("[ERROR] Upload failed:", JSON.stringify(uploadData));
      return res.status(500).json({ error: "Upload failed", details: uploadData });
    }

    console.log("[ROBLOX]", JSON.stringify(uploadData).substring(0, 200));

    // 3) Asset ID çıkar
    let assetId = extractAssetId(uploadData);

    // Operation polling gerekiyorsa
    if (!assetId && uploadData.path && uploadData.path.includes("operation")) {
      console.log("[POLL] Waiting for async operation...");
      assetId = await pollOperation(uploadData.path);
    }

    if (assetId) {
      const result = { assetId: assetId };
      imageCache.set(imageUrl, result);
      console.log("[OK] Asset:", assetId);
      return res.json(result);
    }

    console.log("[WARN] No asset ID found:", JSON.stringify(uploadData));
    return res.json({ assetId: null, pending: true });

  } catch (err) {
    console.error("[FATAL]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ================================================================
// Asset ID çıkarma
// ================================================================
function extractAssetId(data) {
  if (!data) return null;

  // Direkt assetId
  if (data.assetId) return data.assetId.toString();

  // path: "assets/123456"
  if (data.path) {
    const m = data.path.match(/assets\/(\d+)/);
    if (m) return m[1];
  }

  // response.assetId
  if (data.response && data.response.assetId) {
    return data.response.assetId.toString();
  }

  // done + response
  if (data.done && data.response) {
    if (data.response.assetId) return data.response.assetId.toString();
    if (data.response.path) {
      const m = data.response.path.match(/assets\/(\d+)/);
      if (m) return m[1];
    }
  }

  return null;
}

// ================================================================
// Operation polling
// ================================================================
async function pollOperation(opPath) {
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));

    try {
      const url = opPath.startsWith("http")
        ? opPath
        : `https://apis.roblox.com/assets/v1/${opPath}`;

      const res = await fetch(url, {
        headers: { "x-api-key": ROBLOX_API_KEY }
      });

      const data = await res.json();
      console.log(`[POLL ${i+1}]`, JSON.stringify(data).substring(0, 120));

      const id = extractAssetId(data);
      if (id) return id;

      if (data.done) return null; // Done ama ID yok
    } catch (e) {
      console.error("[POLL ERR]", e.message);
    }
  }
  return null;
}

// ================================================================
// Cache yönetimi
// ================================================================
app.get("/cache/clear", (req, res) => {
  if (req.query.key !== SECRET_KEY) return res.status(403).json({ error: "Invalid key" });
  const n = imageCache.size;
  imageCache.clear();
  res.json({ cleared: n });
});

app.get("/cache/status", (req, res) => {
  res.json({
    cached: imageCache.size,
    entries: Array.from(imageCache.entries()).map(([k, v]) => ({
      url: k.substring(0, 60) + "...",
      assetId: v.assetId
    }))
  });
});

// ================================================================
// Başlat
// ================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("========================================");
  console.log("  Roblox YT Image Proxy (Render.com)");
  console.log("  Port:", PORT);
  console.log("  API Key:", ROBLOX_API_KEY ? "OK" : "MISSING!");
  console.log("  Group ID:", ROBLOX_GROUP_ID || "MISSING!");
  console.log("  Secret:", SECRET_KEY !== "degistir" ? "OK" : "DEFAULT!");
  console.log("========================================");
});
