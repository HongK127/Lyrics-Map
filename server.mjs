import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";

const root = fileURLToPath(new URL(".", import.meta.url));
const localConfig = loadLocalConfig();
const port = Number(process.env.PORT || 4174);
const host = process.env.HOST || "0.0.0.0";
const aiProvider = (process.env.AI_PROVIDER || localConfig.ai?.provider || "deepseek").toLowerCase();
const dataDir = join(root, "data");
const uploadsDir = join(root, "uploads");
const dbPath = join(dataDir, "lyrics-map.sqlite");
const uploadLimit = 8 * 1024 * 1024;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml; charset=utf-8",
  ".pdf": "application/pdf",
};

function loadLocalConfig() {
  try {
    return JSON.parse(readFileSync(join(root, "config.local.json"), "utf8"));
  } catch {
    return {};
  }
}

function json(value, fallback = null) {
  if (value === undefined) return fallback;
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function loadSeedData() {
  const source = readFileSync(join(root, "data.js"), "utf8");
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "data.js" });
  return sandbox.window.CHEER_TRAVEL_DATA;
}

function normalizeSection(value) {
  return ["eat", "stay", "move", "shop", "reading", "route"].includes(value) ? value : "eat";
}

function nowIso() {
  return new Date().toISOString();
}

function detectPlatform(value) {
  try {
    const host = new URL(value).hostname.replace(/^www\./, "").toLowerCase();
    if (host.includes("xiaohongshu.com")) return { platform: "小红书", tag: "拍照", host };
    if (host.includes("bilibili.com") || host.includes("b23.tv")) return { platform: "B站", tag: "拍照", host };
    if (host.includes("douyin.com")) return { platform: "抖音", tag: "拍照", host };
    if (host.includes("weibo.com")) return { platform: "微博", tag: "攻略", host };
    if (host.includes("douban.com")) return { platform: "豆瓣", tag: "阅读", host };
    if (host.includes("mocation.cc")) return { platform: "Mocation", tag: "拍照", host };
    if (host.includes("google.com") || host.includes("amap.com") || host.includes("maps")) return { platform: "地图", tag: "攻略", host };
    if (host.includes("instagram.com")) return { platform: "Instagram", tag: "拍照", host };
    if (host.includes("youtube.com") || host.includes("youtu.be")) return { platform: "YouTube", tag: "拍照", host };
    return { platform: "通用链接", tag: "攻略", host };
  } catch {
    return { platform: "通用链接", tag: "攻略", host: "travel note" };
  }
}

function createDb() {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(uploadsDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS destinations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      continent TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      songs_json TEXT NOT NULL,
      lyric_lines_json TEXT NOT NULL,
      intro TEXT NOT NULL,
      hero_image TEXT NOT NULL,
      postcard_image TEXT NOT NULL,
      image_credit_json TEXT NOT NULL,
      sources_json TEXT NOT NULL,
      is_concept INTEGER NOT NULL DEFAULT 0,
      movie_scene_json TEXT,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS songs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT,
      local_cover TEXT,
      cover TEXT,
      cover_upload_url TEXT,
      cover_source_json TEXT,
      fact_source_json TEXT,
      album_source_json TEXT,
      places_json TEXT NOT NULL,
      lyric TEXT,
      notes TEXT,
      origin TEXT NOT NULL DEFAULT 'official',
      status TEXT NOT NULL DEFAULT 'approved',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS guide_items (
      id TEXT PRIMARY KEY,
      destination_id TEXT NOT NULL,
      section TEXT NOT NULL,
      name TEXT NOT NULL,
      author TEXT,
      area TEXT,
      body TEXT,
      reason TEXT,
      best_for TEXT,
      verification TEXT,
      source_json TEXT,
      lat REAL,
      lng REAL,
      origin TEXT NOT NULL DEFAULT 'official',
      status TEXT NOT NULL DEFAULT 'approved',
      locked INTEGER NOT NULL DEFAULT 0,
      curator_label TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS song_places (
      song_id TEXT NOT NULL,
      destination_id TEXT NOT NULL,
      place_label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (song_id, destination_id, sort_order)
    );
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      url TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reviewed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS link_previews (
      url TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      image_url TEXT,
      platform TEXT,
      host TEXT,
      created_at TEXT NOT NULL
    );
  `);
  seedOfficialData(db);
  return db;
}

const db = createDb();

function seedOfficialData(db) {
  const seed = loadSeedData();
  const seedHash = createHash("sha1").update(JSON.stringify(seed)).digest("hex");
  const currentHash = db.prepare("SELECT value FROM meta WHERE key = 'seed_hash'").get()?.value;
  if (currentHash === seedHash) return;

  const insertDestination = db.prepare(`
    INSERT INTO destinations (
      id, name, display_name, continent, lat, lng, songs_json, lyric_lines_json, intro,
      hero_image, postcard_image, image_credit_json, sources_json, is_concept, movie_scene_json, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      display_name=excluded.display_name,
      continent=excluded.continent,
      lat=excluded.lat,
      lng=excluded.lng,
      songs_json=excluded.songs_json,
      lyric_lines_json=excluded.lyric_lines_json,
      intro=excluded.intro,
      hero_image=excluded.hero_image,
      postcard_image=excluded.postcard_image,
      image_credit_json=excluded.image_credit_json,
      sources_json=excluded.sources_json,
      is_concept=excluded.is_concept,
      movie_scene_json=excluded.movie_scene_json,
      raw_json=excluded.raw_json
  `);
  const insertGuide = db.prepare(`
    INSERT INTO guide_items (
      id, destination_id, section, name, author, area, body, reason, best_for,
      verification, source_json, lat, lng, origin, status, locked, curator_label, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      destination_id=excluded.destination_id,
      section=excluded.section,
      name=excluded.name,
      author=excluded.author,
      area=excluded.area,
      body=excluded.body,
      reason=excluded.reason,
      best_for=excluded.best_for,
      verification=excluded.verification,
      source_json=excluded.source_json,
      lat=excluded.lat,
      lng=excluded.lng,
      origin=excluded.origin,
      status=excluded.status,
      locked=excluded.locked,
      curator_label=excluded.curator_label
  `);
  const insertSong = db.prepare(`
    INSERT INTO songs (
      id, title, artist, album, local_cover, cover, cover_upload_url, cover_source_json,
      fact_source_json, album_source_json, places_json, lyric, notes, origin, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      artist=excluded.artist,
      album=excluded.album,
      local_cover=excluded.local_cover,
      cover=excluded.cover,
      cover_upload_url=excluded.cover_upload_url,
      cover_source_json=excluded.cover_source_json,
      fact_source_json=excluded.fact_source_json,
      album_source_json=excluded.album_source_json,
      places_json=excluded.places_json,
      lyric=excluded.lyric,
      notes=excluded.notes,
      origin=excluded.origin,
      status=excluded.status
  `);
  const insertSongPlace = db.prepare(`
    INSERT OR REPLACE INTO song_places (song_id, destination_id, place_label, sort_order)
    VALUES (?, ?, ?, ?)
  `);

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM guide_items WHERE origin = 'official'").run();
    db.prepare("DELETE FROM song_places").run();
    seed.destinations.forEach((item) => {
      insertDestination.run(
        item.id,
        item.name,
        item.displayName,
        item.continent,
        item.lat,
        item.lng,
        json(item.songs, []),
        json(item.lyricLines, []),
        item.intro,
        item.heroImage,
        item.postcardImage,
        json(item.imageCredit, null),
        json(item.sources, []),
        item.isConceptPlace ? 1 : 0,
        json(item.movieScene, null),
        json(item, {})
      );
      ["eat", "stay", "move", "shop"].forEach((section) => {
        (item.recommendations?.[section] || []).forEach((row, index) => {
          insertGuide.run(
            `official:${item.id}:${section}:${index}`,
            item.id,
            section,
            row.name,
            "",
            row.area || `${item.displayName} · ${row.name}`,
            row.description || "",
            row.reason || "",
            row.bestFor || "",
            row.verification || "",
            json(row.source, null),
            row.lat,
            row.lng,
            "official",
            "approved",
            1,
            "创作者倾情制作",
            nowIso()
          );
        });
      });
      (item.readingRecommendations || []).forEach((book, index) => {
        insertGuide.run(
          `official:${item.id}:reading:${index}`,
          item.id,
          "reading",
          book.title,
          book.author || "",
          `${item.displayName} · 阅读`,
          book.note || "",
          book.note || "",
          "适合带去读的书",
          "创作者倾情制作；公开资料请打开来源核验。",
          json(book.source, null),
          null,
          null,
          "official",
          "approved",
          1,
          "创作者倾情制作",
          nowIso()
        );
      });
      (item.route || []).forEach((step, index) => {
        const title = typeof step === "string" ? step : step.title;
        insertGuide.run(
          `official:${item.id}:route:${index}`,
          item.id,
          "route",
          title || `Day ${index + 1}`,
          "",
          typeof step === "string" ? item.displayName : step.area,
          typeof step === "string" ? step : [step.morning, step.afternoon, step.evening, step.note].filter(Boolean).join("\n"),
          typeof step === "string" ? step : step.note,
          typeof step === "string" ? "官方路线" : `Day ${step.day}`,
          "创作者倾情制作；交通、营业时间和票务请出发前再次确认。",
          json(typeof step === "string" ? null : step.source, null),
          index === 0 ? item.lat : null,
          index === 0 ? item.lng : null,
          "official",
          "approved",
          1,
          "创作者倾情制作",
          nowIso()
        );
      });
    });
    seed.songs.forEach((song) => {
      insertSong.run(
        song.id,
        song.title,
        song.artist || "",
        song.album || "",
        song.localCover || "",
        song.cover || "",
        "",
        json(song.coverSource, null),
        json(song.factSource, null),
        json(song.albumSource, null),
        json(song.places, []),
        song.lyric || "",
        song.notes || "",
        "official",
        "approved",
        nowIso()
      );
      (song.places || []).forEach((place, index) => {
        const dest = seed.destinations.find((item) =>
          item.name === place ||
          item.displayName.includes(place) ||
          place.includes(item.name)
        );
        if (dest) insertSongPlace.run(song.id, dest.id, place, index);
      });
    });
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('seed_hash', ?)").run(seedHash);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('seed_accessed', ?)").run(seed.accessed || nowIso());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function publicDestination(row) {
  const raw = parseJson(row.raw_json, {});
  return {
    ...raw,
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    continent: row.continent,
    lat: row.lat,
    lng: row.lng,
    songs: parseJson(row.songs_json, []),
    lyricLines: parseJson(row.lyric_lines_json, []),
    intro: row.intro,
    heroImage: row.hero_image,
    postcardImage: row.postcard_image,
    imageCredit: parseJson(row.image_credit_json, null),
    sources: parseJson(row.sources_json, []),
    isConceptPlace: !!row.is_concept,
    movieScene: parseJson(row.movie_scene_json, null),
  };
}

function guideRowToItem(row) {
  return {
    id: row.id,
    destinationId: row.destination_id,
    section: row.section,
    name: row.name,
    title: row.name,
    author: row.author || "",
    area: row.area || "",
    body: row.body || "",
    description: row.body || "",
    reason: row.reason || row.body || "",
    bestFor: row.best_for || "",
    verification: row.verification || "",
    source: parseJson(row.source_json, null),
    lat: row.lat,
    lng: row.lng,
    origin: row.origin,
    status: row.status,
    locked: !!row.locked,
    curatorLabel: row.curator_label || "",
    createdAt: row.created_at,
  };
}

function songRowToItem(row) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album || "",
    localCover: row.cover_upload_url || row.local_cover || "",
    cover: row.cover || "",
    coverUploadUrl: row.cover_upload_url || "",
    coverSource: parseJson(row.cover_source_json, null),
    factSource: parseJson(row.fact_source_json, null),
    albumSource: parseJson(row.album_source_json, null),
    places: parseJson(row.places_json, []),
    lyric: row.lyric || "",
    notes: row.notes || "",
    origin: row.origin,
    status: row.status,
    createdAt: row.created_at,
  };
}

function getBootstrapPayload() {
  const destinations = db.prepare("SELECT * FROM destinations ORDER BY rowid").all().map(publicDestination);
  const guideRows = db.prepare("SELECT * FROM guide_items WHERE status = 'approved' ORDER BY created_at, rowid").all();
  destinations.forEach((destination) => {
    const rows = guideRows.filter((row) => row.destination_id === destination.id).map(guideRowToItem);
    destination.recommendations = { eat: [], stay: [], move: [], shop: [] };
    rows.filter((row) => row.origin === "official" && ["eat", "stay", "move", "shop"].includes(row.section))
      .forEach((row) => destination.recommendations[row.section].push(row));
    destination.readingRecommendations = rows
      .filter((row) => row.origin === "official" && row.section === "reading")
      .map((row) => ({ title: row.name, author: row.author, note: row.body || row.reason, source: row.source, curatorLabel: row.curatorLabel, locked: row.locked }));
    const rawRoute = parseJson(db.prepare("SELECT raw_json FROM destinations WHERE id = ?").get(destination.id)?.raw_json, {}).route || [];
    destination.route = rawRoute;
    destination.approvedGuides = rows.filter((row) => row.origin !== "official");
  });
  const songs = db.prepare("SELECT * FROM songs WHERE status = 'approved' ORDER BY origin DESC, created_at DESC, rowid").all().map(songRowToItem);
  const continents = loadSeedData().continents;
  return {
    accessed: db.prepare("SELECT value FROM meta WHERE key = 'seed_accessed'").get()?.value || "",
    destinations,
    songs,
    continents,
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendConfig(res) {
  const publicConfig = {
    amap: {
      key: process.env.AMAP_KEY || localConfig.amap?.key || "",
      securityJsCode: process.env.AMAP_SECURITY_JS_CODE || localConfig.amap?.securityJsCode || "",
      style: process.env.AMAP_STYLE || localConfig.amap?.style || "amap://styles/macaron",
    },
    ai: {
      provider: aiProvider,
      model: process.env.AI_MODEL || process.env.DEEPSEEK_MODEL || process.env.DOUBAO_MODEL || localConfig.ai?.model || "",
    },
  };
  res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
  res.end(`window.CHEER_TRAVEL_CONFIG = ${JSON.stringify(publicConfig)};`);
}

async function readBuffer(req, limit = 1_000_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buffer = await readBuffer(req, 200_000);
  return buffer.length ? JSON.parse(buffer.toString("utf8")) : {};
}

function safeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("//")) return "";
  if (raw.startsWith("./") || raw.startsWith("/")) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function safeNumber(value, min = -Infinity, max = Infinity) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function cleanPackageRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: String(row.id || randomUUID()).trim(),
    name: String(row.name || row.title || "").trim(),
    title: String(row.title || row.name || "").trim(),
    author: String(row.author || "").trim(),
    area: String(row.area || "").trim(),
    body: String(row.body || row.note || row.reason || "").trim(),
    reason: String(row.reason || row.body || row.note || "").trim(),
    bestFor: String(row.bestFor || row.best_for || "").trim(),
    verification: String(row.verification || "").trim(),
    day: row.day || "",
    morning: String(row.morning || "").trim(),
    afternoon: String(row.afternoon || "").trim(),
    evening: String(row.evening || "").trim(),
    note: String(row.note || "").trim(),
    source: {
      sourceName: String(row.source?.sourceName || row.sourceName || "用户投稿来源").trim(),
      sourceUrl: safeUrl(row.source?.sourceUrl || row.sourceUrl),
    },
    lat: safeNumber(row.lat, -90, 90),
    lng: safeNumber(row.lng, -180, 180),
  })).filter((row) => row.name || row.title || row.body || row.reason || row.note || row.morning || row.afternoon || row.evening);
}

function requireAdmin(req, res) {
  const expected = process.env.ADMIN_TOKEN || localConfig.admin?.token || localConfig.adminToken || "";
  if (!expected) return true;
  const actual = req.headers.authorization?.replace(/^Bearer\s+/i, "") || req.headers["x-admin-token"];
  if (actual === expected) return true;
  sendJson(res, 401, { error: "Missing or invalid admin token" });
  return false;
}

function searchPayload(q, scope = "all") {
  const query = String(q || "").trim().toLowerCase();
  if (!query) return { query: "", destinations: [], guides: [], songs: [] };
  const payload = getBootstrapPayload();
  const contains = (value) => String(value || "").toLowerCase().includes(query);
  const destinations = scope === "guides" || scope === "songs" ? [] : payload.destinations.filter((item) =>
    contains([
      item.displayName,
      item.name,
      item.continent,
      item.intro,
      item.songs.join(" "),
      item.lyricLines.join(" "),
    ].join(" "))
  );
  const guides = scope === "destinations" || scope === "songs" ? [] : payload.destinations.flatMap((destination) => {
    const all = [
      ...["eat", "stay", "move", "shop"].flatMap((section) => (destination.recommendations[section] || []).map((row) => ({ ...row, section }))),
      ...(destination.readingRecommendations || []).map((book) => ({ ...book, section: "reading", name: book.title, reason: book.note })),
      ...(destination.approvedGuides || []),
      ...(destination.route || []).map((step) => ({ section: "route", name: typeof step === "string" ? step : step.title, reason: typeof step === "string" ? step : [step.area, step.morning, step.afternoon, step.evening, step.note].join(" ") })),
    ];
    return all
      .filter((row) => contains([destination.displayName, row.section, row.name, row.title, row.author, row.area, row.body, row.reason, row.bestFor].join(" ")))
      .map((row) => ({ ...row, destinationId: destination.id, destinationName: destination.displayName }));
  });
  const songs = scope === "destinations" || scope === "guides" ? [] : payload.songs.filter((song) =>
    contains([song.title, song.artist, song.album, song.lyric, song.notes, song.places.join(" ")].join(" "))
  );
  return { query, destinations, guides, songs };
}

async function handleUpload(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  const contentType = req.headers["content-type"] || "";
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.[1] || /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.[2];
  if (!boundary) {
    sendJson(res, 400, { error: "Missing multipart boundary" });
    return;
  }
  const buffer = await readBuffer(req, uploadLimit);
  const parts = buffer.toString("latin1").split(`--${boundary}`).filter((part) => part.includes("Content-Disposition"));
  const filePart = parts.find((part) => /filename="/i.test(part));
  if (!filePart) {
    sendJson(res, 400, { error: "Missing file" });
    return;
  }
  const headerEnd = filePart.indexOf("\r\n\r\n");
  const header = filePart.slice(0, headerEnd);
  let body = filePart.slice(headerEnd + 4);
  body = body.replace(/\r\n--$/, "").replace(/\r\n$/, "");
  const originalName = /filename="([^"]*)"/i.exec(header)?.[1] || "upload";
  const partMime = /Content-Type:\s*([^\r\n]+)/i.exec(header)?.[1]?.trim() || "application/octet-stream";
  if (!partMime.startsWith("image/")) {
    sendJson(res, 415, { error: "Only image uploads are supported in this prototype" });
    return;
  }
  const ext = (extname(originalName).toLowerCase() || ".jpg").replace(/[^a-z0-9.]/g, "") || ".jpg";
  const id = randomUUID();
  const filename = `${id}${ext}`;
  const fileBuffer = Buffer.from(body, "latin1");
  writeFileSync(join(uploadsDir, filename), fileBuffer);
  const url = `/uploads/${filename}`;
  db.prepare("INSERT INTO uploads (id, filename, original_name, mime, size, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, filename, originalName, partMime, fileBuffer.length, url, nowIso());
  sendJson(res, 201, { id, url, filename, originalName, mime: partMime, size: fileBuffer.length });
}

function submissionPayload(type, payload) {
  if (type === "song") {
    return {
      title: String(payload.title || "").trim(),
      artist: String(payload.artist || "").trim(),
      album: String(payload.album || "").trim(),
      places: Array.isArray(payload.places) ? payload.places.map(String).filter(Boolean) : [],
      lyric: String(payload.lyric || "").trim(),
      notes: String(payload.notes || "").trim(),
      sourceUrl: safeUrl(payload.sourceUrl),
      coverUploadUrl: safeUrl(payload.coverUploadUrl),
      contributor: String(payload.contributor || "").trim(),
    };
  }
  if (payload.sections && typeof payload.sections === "object") {
    const sections = payload.sections || {};
    return {
      id: String(payload.id || randomUUID()).trim(),
      destinationId: String(payload.destinationId || "").trim(),
      title: String(payload.title || "").trim(),
      coverImage: safeUrl(payload.coverImage),
      origin: "submission",
      status: "pending",
      locked: false,
      curatorLabel: "用户投稿攻略",
      contributor: String(payload.contributor || "").trim(),
      summary: String(payload.summary || "").trim(),
      sourceUrl: safeUrl(payload.sourceUrl),
      sections: {
        eat: cleanPackageRows(sections.eat),
        stay: cleanPackageRows(sections.stay),
        move: cleanPackageRows(sections.move),
        shop: cleanPackageRows(sections.shop),
        reading: cleanPackageRows(sections.reading),
        sevenDayRoute: cleanPackageRows(sections.sevenDayRoute),
      },
    };
  }
  return {
    destinationId: String(payload.destinationId || "").trim(),
    section: normalizeSection(payload.section),
    title: String(payload.title || "").trim(),
    author: String(payload.author || "").trim(),
    body: String(payload.body || "").trim(),
    sourceUrl: safeUrl(payload.sourceUrl),
    lat: Number.isFinite(Number(payload.lat)) ? Number(payload.lat) : null,
    lng: Number.isFinite(Number(payload.lng)) ? Number(payload.lng) : null,
    contributor: String(payload.contributor || "").trim(),
  };
}

async function handleSubmission(req, res, type) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  const payload = submissionPayload(type, await readJson(req));
  if (type === "song" && !payload.title) {
    sendJson(res, 400, { error: "Missing song title" });
    return;
  }
  if (type === "guide" && (!payload.destinationId || !payload.title)) {
    sendJson(res, 400, { error: "Missing guide destination or title" });
    return;
  }
  const id = randomUUID();
  db.prepare("INSERT INTO submissions (id, type, status, payload_json, created_at) VALUES (?, ?, 'pending', ?, ?)")
    .run(id, type, json(payload, {}), nowIso());
  sendJson(res, 201, { id, type, status: "pending", payload });
}

function approveSubmission(row) {
  const payload = parseJson(row.payload_json, {});
  if (row.type === "song") {
    const songId = `song:${row.id}`;
    db.prepare(`
      INSERT OR REPLACE INTO songs (
        id, title, artist, album, local_cover, cover, cover_upload_url, cover_source_json,
        fact_source_json, album_source_json, places_json, lyric, notes, origin, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submission', 'approved', ?)
    `).run(
      songId,
      payload.title || "未命名歌曲",
      payload.artist || "待补充歌手",
      payload.album || "用户投稿",
      payload.coverUploadUrl || "",
      "",
      payload.coverUploadUrl || "",
      json({ sourceName: "用户上传封面", sourceUrl: payload.coverUploadUrl || "" }, null),
      json({ sourceName: "用户投稿来源", sourceUrl: payload.sourceUrl || "" }, null),
      json({ sourceName: "用户投稿来源", sourceUrl: payload.sourceUrl || "" }, null),
      json(payload.places || [], []),
      payload.lyric || "",
      payload.notes || "用户投稿已通过审核。",
      nowIso()
    );
    (payload.places || []).forEach((place, index) => {
      const dest = db.prepare("SELECT id, name, display_name FROM destinations").all().find((item) =>
        item.name === place || item.display_name.includes(place) || place.includes(item.name)
      );
      if (dest) {
        db.prepare("INSERT OR REPLACE INTO song_places (song_id, destination_id, place_label, sort_order) VALUES (?, ?, ?, ?)")
          .run(songId, dest.id, place, index);
      }
    });
  } else if (payload.sections && typeof payload.sections === "object") {
    const packageId = `approved:${row.id}`;
    const insertGuide = db.prepare(`
      INSERT OR REPLACE INTO guide_items (
        id, destination_id, section, name, author, area, body, reason, best_for,
        verification, source_json, lat, lng, origin, status, locked, curator_label, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submission', 'approved', 0, '用户投稿攻略', ?)
    `);
    Object.entries(payload.sections).forEach(([sectionKey, rows]) => {
      const dbSection = sectionKey === "sevenDayRoute" ? "route" : normalizeSection(sectionKey);
      (Array.isArray(rows) ? rows : []).forEach((entry, index) => {
        const name = entry.name || entry.title || `${payload.title || "用户投稿攻略"} ${index + 1}`;
        const source = {
          ...(entry.source || {}),
          sourceName: entry.source?.sourceName || "用户投稿来源",
          sourceUrl: entry.source?.sourceUrl || payload.sourceUrl || "",
          packageId,
          packageTitle: payload.title || "用户投稿完整攻略",
          packageCover: payload.coverImage || "",
          packageSummary: payload.summary || "",
          routeKind: sectionKey,
        };
        insertGuide.run(
          `guide:${row.id}:${sectionKey}:${index}`,
          payload.destinationId,
          dbSection,
          name,
          entry.author || payload.contributor || "",
          entry.area || "",
          entry.body || entry.note || [entry.morning, entry.afternoon, entry.evening].filter(Boolean).join("\n"),
          entry.reason || entry.note || "",
          entry.bestFor || (sectionKey.includes("Route") ? "用户投稿路线" : "用户投稿完整攻略"),
          entry.verification || "用户投稿已通过审核；出发前仍建议打开来源核验。",
          json(source, null),
          entry.lat,
          entry.lng,
          nowIso()
        );
      });
    });
  } else {
    db.prepare(`
      INSERT OR REPLACE INTO guide_items (
        id, destination_id, section, name, author, area, body, reason, best_for,
        verification, source_json, lat, lng, origin, status, locked, curator_label, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submission', 'approved', 0, '用户投稿收录', ?)
    `).run(
      `guide:${row.id}`,
      payload.destinationId,
      normalizeSection(payload.section),
      payload.title || "用户投稿",
      payload.author || payload.contributor || "",
      payload.author || "用户投稿",
      payload.body || "",
      payload.body || "",
      "用户投稿收录",
      "用户投稿已通过审核；出发前仍建议打开来源核验。",
      json({ sourceName: "用户投稿来源", sourceUrl: payload.sourceUrl || "" }, null),
      payload.lat,
      payload.lng,
      nowIso()
    );
  }
}

async function handleAdminSubmission(req, res, id, action) {
  if (!requireAdmin(req, res)) return;
  const row = db.prepare("SELECT * FROM submissions WHERE id = ?").get(id);
  if (!row) {
    sendJson(res, 404, { error: "Submission not found" });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (action === "approve") approveSubmission(row);
  const next = action === "approve" ? "approved" : "rejected";
  db.prepare("UPDATE submissions SET status = ?, reviewed_at = ? WHERE id = ?").run(next, nowIso(), id);
  sendJson(res, 200, { id, status: next });
}

function fallbackPreview(url) {
  const meta = detectPlatform(url);
  const imageByPlatform = {
    小红书: "./assets/journal/memo-board-ref.png",
    豆瓣: "./assets/journal/travel-word.jpg",
    地图: "./assets/journal/planner-map-ref.png",
    Mocation: "./assets/journal/map-stickers.jpg",
  };
  return {
    url,
    title: `${meta.platform}灵感卡`,
    description: `来自 ${meta.host} 的旅行线索，可作为攻略、机位或阅读资料继续整理。`,
    imageUrl: imageByPlatform[meta.platform] || "./assets/journal/folded-map.jpg",
    platform: meta.platform,
    host: meta.host,
    tag: meta.tag,
  };
}

async function handleLinkPreview(req, res, url) {
  const normalized = safeUrl(url);
  if (!normalized) {
    sendJson(res, 400, { error: "Invalid URL" });
    return;
  }
  const cached = db.prepare("SELECT * FROM link_previews WHERE url = ?").get(normalized);
  if (cached) {
    sendJson(res, 200, {
      url: normalized,
      title: cached.title,
      description: cached.description,
      imageUrl: cached.image_url,
      platform: cached.platform,
      host: cached.host,
      tag: detectPlatform(normalized).tag,
    });
    return;
  }
  let preview = fallbackPreview(normalized);
  try {
    const upstream = await fetch(normalized, {
      signal: AbortSignal.timeout(3500),
      headers: { "User-Agent": "LyricsMapPrototype/1.0" },
    });
    const html = await upstream.text();
    const pick = (pattern) => pattern.exec(html)?.[1]?.replace(/\s+/g, " ").trim();
    const title = pick(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)/i) || pick(/<title[^>]*>([^<]+)/i);
    const description = pick(/<meta\s+(?:name|property)=["'](?:description|og:description)["']\s+content=["']([^"']+)/i);
    const image = pick(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)/i);
    preview = {
      ...preview,
      title: title || preview.title,
      description: description || preview.description,
      imageUrl: safeUrl(image) || preview.imageUrl,
    };
  } catch {
    // External sites often block preview scraping; keep a useful local visual fallback.
  }
  db.prepare("INSERT OR REPLACE INTO link_previews (url, title, description, image_url, platform, host, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(normalized, preview.title, preview.description, preview.imageUrl, preview.platform, preview.host, nowIso());
  sendJson(res, 200, preview);
}

function basicPdfFromText(title, lines) {
  const safeLines = [title, "", ...lines].map((line) => String(line || "").replace(/[^\x20-\x7e]/g, "?"));
  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let offset = 0;
  const addBytes = (bytes) => {
    chunks.push(bytes);
    offset += bytes.length;
  };
  const addString = (value) => addBytes(encoder.encode(value));
  const addObject = (id, body) => {
    offsets[id] = offset;
    addString(`${id} 0 obj\n${body}\nendobj\n`);
  };
  const text = safeLines.slice(0, 42).map((line, index) => `BT /F1 ${index === 0 ? 18 : 11} Tf 48 ${780 - index * 18} Td (${line.replace(/[()\\]/g, "\\$&")}) Tj ET`).join("\n");
  addString("%PDF-1.4\n");
  addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
  addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  addObject(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>");
  addObject(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  addObject(5, `<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  const xrefOffset = offset;
  addString("xref\n0 6\n0000000000 65535 f \n");
  for (let i = 1; i <= 5; i += 1) addString(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  addString(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return Buffer.concat(chunks);
}

async function handlePlannerPdf(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  const payload = await readJson(req);
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  const pdf = basicPdfFromText(payload.title || "Lyrics Map Travel Planner", lines);
  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": "attachment; filename=travel-planner.pdf",
  });
  res.end(pdf);
}

function getAiSettings() {
  const commonKey = process.env.AI_API_KEY || localConfig.ai?.apiKey;
  const commonBaseUrl = process.env.AI_BASE_URL || localConfig.ai?.baseUrl;
  if (aiProvider === "doubao") {
    return {
      provider: "doubao",
      apiKey: commonKey || process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY || localConfig.ai?.doubaoApiKey,
      baseUrl: commonBaseUrl || process.env.DOUBAO_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
      model: process.env.AI_MODEL || process.env.DOUBAO_MODEL || localConfig.ai?.model,
    };
  }
  return {
    provider: "deepseek",
    apiKey: commonKey || process.env.DEEPSEEK_API_KEY || localConfig.ai?.deepseekApiKey,
    baseUrl: commonBaseUrl || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/chat/completions",
    model: process.env.AI_MODEL || process.env.DEEPSEEK_MODEL || localConfig.ai?.model || "deepseek-chat",
  };
}

async function handleAiChat(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  const { prompt } = await readJson(req);
  if (!prompt || typeof prompt !== "string") {
    sendJson(res, 400, { error: "Missing prompt" });
    return;
  }

  const settings = getAiSettings();
  if (!settings.apiKey) {
    sendJson(res, 501, {
      error: `请先设置 ${settings.provider === "doubao" ? "DOUBAO_API_KEY / ARK_API_KEY" : "DEEPSEEK_API_KEY"}，或设置通用 AI_API_KEY。`,
    });
    return;
  }
  if (!settings.model) {
    sendJson(res, 501, { error: "请设置 AI_MODEL 或对应供应商的模型名环境变量。" });
    return;
  }

  const upstream = await fetch(settings.baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        {
          role: "system",
          content: "你是温柔、可靠、会做实时核验提示的中文旅行助手。涉及营业时间、交通、价格、天气和活动时，必须提醒用户出发前再次确认。",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.75,
      stream: false,
    }),
  });

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    sendJson(res, upstream.status, { error: data.error?.message || data.message || "AI provider request failed" });
    return;
  }
  const text = data.choices?.[0]?.message?.content || data.output_text || "";
  sendJson(res, 200, { provider: settings.provider, model: settings.model, text });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === "/config.js") {
    sendConfig(res);
    return;
  }
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const fullPath = normalize(join(root, pathname));
  const rel = relative(root, fullPath);

  if (rel.startsWith("..") || normalize(fullPath) === normalize(root)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  try {
    const data = await readFile(fullPath);
    res.writeHead(200, { "Content-Type": mime[extname(fullPath).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function routeApi(req, res, url) {
  if (url.pathname === "/api/bootstrap") {
    sendJson(res, 200, getBootstrapPayload());
    return true;
  }
  if (url.pathname === "/api/search") {
    sendJson(res, 200, searchPayload(url.searchParams.get("q"), url.searchParams.get("scope") || "all"));
    return true;
  }
  const guideMatch = /^\/api\/destinations\/([^/]+)\/guides$/.exec(url.pathname);
  if (guideMatch) {
    const rows = db.prepare("SELECT * FROM guide_items WHERE destination_id = ? AND status = 'approved' ORDER BY origin, section, rowid").all(decodeURIComponent(guideMatch[1]));
    sendJson(res, 200, { items: rows.map(guideRowToItem) });
    return true;
  }
  if (url.pathname === "/api/songs") {
    sendJson(res, 200, { songs: db.prepare("SELECT * FROM songs WHERE status = 'approved' ORDER BY origin DESC, created_at DESC, rowid").all().map(songRowToItem) });
    return true;
  }
  if (url.pathname === "/api/uploads") {
    await handleUpload(req, res);
    return true;
  }
  if (url.pathname === "/api/submissions/guide") {
    await handleSubmission(req, res, "guide");
    return true;
  }
  if (url.pathname === "/api/submissions/song") {
    await handleSubmission(req, res, "song");
    return true;
  }
  if (url.pathname === "/api/admin/submissions") {
    if (!requireAdmin(req, res)) return true;
    const status = url.searchParams.get("status") || "pending";
    const rows = db.prepare("SELECT * FROM submissions WHERE status = ? ORDER BY created_at DESC").all(status);
    sendJson(res, 200, { submissions: rows.map((row) => ({ ...row, payload: parseJson(row.payload_json, {}) })) });
    return true;
  }
  const adminMatch = /^\/api\/admin\/submissions\/([^/]+)\/(approve|reject)$/.exec(url.pathname);
  if (adminMatch) {
    await handleAdminSubmission(req, res, decodeURIComponent(adminMatch[1]), adminMatch[2]);
    return true;
  }
  if (url.pathname === "/api/link-preview") {
    await handleLinkPreview(req, res, url.searchParams.get("url"));
    return true;
  }
  if (url.pathname === "/api/planner/export-pdf") {
    await handlePlannerPdf(req, res);
    return true;
  }
  if (url.pathname === "/api/ai/chat") {
    await handleAiChat(req, res);
    return true;
  }
  return false;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname.startsWith("/api/") && await routeApi(req, res, url)) return;
    await serveStatic(req, res);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(port, host, () => {
  console.log(`Lyrics Map running at http://localhost:${port}`);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        console.log(`LAN access: http://${address.address}:${port}`);
      }
    }
  }
  if (!existsSync(dbPath)) console.log("SQLite database will be created on first request.");
});

server.on("error", (error) => {
  console.error(`Failed to start Lyrics Map on ${host}:${port}`);
  console.error(error);
});

export { server };
