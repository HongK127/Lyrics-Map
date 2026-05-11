let { destinations, songs, continents } = window.CHEER_TRAVEL_DATA;
let byId = new Map(destinations.map((item) => [item.id, item]));
const defaultConfig = {
  amap: {
    key: "04efa1e90d297891156539a4bd788c48",
    securityJsCode: "da7e76f92da228cc8ec04f42c434adcb",
    style: "amap://styles/macaron",
  },
  ai: {
    provider: "deepseek",
    model: "deepseek-chat",
  },
};
const config = {
  amap: { ...defaultConfig.amap, ...(window.CHEER_TRAVEL_CONFIG?.amap || {}) },
  ai: { ...defaultConfig.ai, ...(window.CHEER_TRAVEL_CONFIG?.ai || {}) },
};
const amapConfig = config.amap || {};
const aiConfig = config.ai || {};

let activeContinent = "all";
let activeQuery = "";
let guideArchiveQuery = "";
let songArchiveQuery = "";
let homeMap;
let homeMarkers = [];
let AMapRuntime;
let AMapScriptPromise;
let songRouteMap;
let songRouteMarkers = [];

async function apiJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`);
  return data;
}

async function postJson(url, body) {
  return apiJson(url, { method: "POST", body: JSON.stringify(body) });
}

async function uploadFile(file) {
  if (!file) return null;
  const form = new FormData();
  form.append("file", file);
  return apiJson("/api/uploads", { method: "POST", body: form });
}

async function loadBootstrapData() {
  if (!location.protocol.startsWith("http")) return;
  try {
    const data = await apiJson("/api/bootstrap");
    destinations = data.destinations || destinations;
    songs = data.songs || songs;
    continents = data.continents || continents;
    byId = new Map(destinations.map((item) => [item.id, item]));
    window.CHEER_TRAVEL_DATA = { ...window.CHEER_TRAVEL_DATA, ...data };
  } catch (error) {
    console.warn("Using embedded prototype data:", error.message);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeExternalUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("//")) return "";
  if (raw.startsWith("./") || raw.startsWith("/")) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) return "";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withProtocol);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function destinationUrl(item) {
  return `./destination.html?id=${encodeURIComponent(item.id)}`;
}

function setImage(img, src, alt) {
  if (!img) return;
  img.loading = "lazy";
  img.src = src;
  img.alt = alt || "";
  img.onerror = () => {
    img.src = "./assets/journal/folded-map.jpg";
    img.classList.add("image-fallback");
  };
}

function sourceLink(src) {
  if (!src) return "";
  const label = src.pending ? `${src.sourceName} · 待核验` : src.sourceName;
  const href = safeExternalUrl(src.sourceUrl);
  return href
    ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
    : escapeHtml(label);
}

const customGuidesStorageKey = "lyrics-map-custom-guides-v1";
const hiddenGuideItemsStorageKey = "lyrics-map-hidden-guide-items-v1";
const contributionsStorageKey = "lyrics-map-contributions-v1";
const customGuideSections = ["eat", "stay", "move", "shop", "reading", "route"];
const customGuideMeta = {
  eat: { icon: "🍜", label: "吃" },
  stay: { icon: "🏨", label: "住" },
  move: { icon: "🚇", label: "行" },
  shop: { icon: "🛍", label: "购物" },
  reading: { icon: "📚", label: "阅读" },
  route: { icon: "🧭", label: "路线" },
};
const customGuideState = {
  items: [],
  hiddenIds: new Set(),
};
const contributionState = {
  items: [],
};
let localMapInstance;
let activeGuidePackageId = "";
const geocodeCacheStorageKey = "lyrics-map-geocode-cache-v1";
let geocodeCache;

function userContentId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function loadJsonArray(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveJsonArray(key, value) {
  localStorage.setItem(key, JSON.stringify(Array.isArray(value) ? value : []));
}

function cleanGuideSection(value) {
  return customGuideSections.includes(value) ? value : "eat";
}

function cleanNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (number < min || number > max) return null;
  return Number(number.toFixed(6));
}

function normalizeCustomGuideItem(item) {
  const section = cleanGuideSection(item?.section);
  return {
    id: item?.id || userContentId("guide"),
    destinationId: item?.destinationId || "",
    section,
    title: String(item?.title || "").trim(),
    author: String(item?.author || "").trim(),
    body: String(item?.body || "").trim(),
    sourceUrl: safeExternalUrl(item?.sourceUrl),
    lat: cleanNumber(item?.lat, -90, 90),
    lng: cleanNumber(item?.lng, -180, 180),
    createdAt: Number(item?.createdAt) || Date.now(),
  };
}

function normalizeContributionItem(item) {
  const type = item?.type === "song" ? "song" : item?.type === "guide-package" ? "guide-package" : "destination";
  if (type === "song") {
    return {
      id: item?.id || userContentId("contribution"),
      type,
      title: String(item?.title || "").trim(),
      artist: String(item?.artist || "").trim(),
      album: String(item?.album || "").trim(),
      places: Array.isArray(item?.places) ? item.places.map((place) => String(place || "").trim()).filter(Boolean) : [],
      lyric: String(item?.lyric || "").trim(),
      notes: String(item?.notes || "").trim(),
      sourceUrl: safeExternalUrl(item?.sourceUrl),
      coverUploadUrl: safeExternalUrl(item?.coverUploadUrl),
      status: item?.status || "待收录",
      createdAt: Number(item?.createdAt) || Date.now(),
    };
  }
  if (type === "guide-package") {
    return {
      id: item?.id || userContentId("contribution"),
      type,
      destinationId: item?.destinationId || item?.package?.destinationId || "",
      status: item?.status || "待审核",
      package: item?.package || item?.guidePackage || null,
      createdAt: Number(item?.createdAt) || Date.now(),
    };
  }
  return {
    ...normalizeCustomGuideItem(item),
    id: item?.id || userContentId("contribution"),
    type,
    status: item?.status || "待收录",
  };
}

function loadUserContentState() {
  customGuideState.items = loadJsonArray(customGuidesStorageKey).map(normalizeCustomGuideItem);
  customGuideState.hiddenIds = new Set(loadJsonArray(hiddenGuideItemsStorageKey).map(String));
  contributionState.items = loadJsonArray(contributionsStorageKey).map(normalizeContributionItem);
}

function saveCustomGuides() {
  saveJsonArray(customGuidesStorageKey, customGuideState.items);
}

function saveHiddenGuides() {
  saveJsonArray(hiddenGuideItemsStorageKey, [...customGuideState.hiddenIds]);
}

function saveContributions() {
  saveJsonArray(contributionsStorageKey, contributionState.items);
}

function officialGuideId(destinationId, section, index) {
  return `official:${destinationId}:${section}:${index}`;
}

function isHiddenGuide(id) {
  return customGuideState.hiddenIds.has(id);
}

function sourceChip(url, label = "打开来源") {
  const href = safeExternalUrl(url);
  return href
    ? `<a class="source-chip" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
    : "";
}

function contributionBadge(label = "用户投稿 / 待收录") {
  return `<span class="user-badge">${escapeHtml(label)}</span>`;
}

function movieSceneCard(item, compact = false) {
  if (!item?.movieScene) return "";
  const url = item.movieScene.url;
  if (compact) {
    return `
      <span class="movie-chip">
        <strong>${escapeHtml(item.movieScene.label)}</strong>
        <small>${escapeHtml(url)}</small>
      </span>
    `;
  }
  return `
    <a class="movie-scene-card" href="${url}" target="_blank" rel="noreferrer">
      <img src="${item.postcardImage}" alt="">
      <span>
        <strong>${escapeHtml(item.movieScene.label)}</strong>
        <small>${escapeHtml(url)}</small>
      </span>
    </a>
  `;
}

function showMapSetup(el, message = "请在启动服务前设置 AMAP_KEY，可选设置 AMAP_SECURITY_JS_CODE。") {
  if (!el) return;
  el.innerHTML = `
    <div class="map-empty">
      <strong>高德地图暂未显示</strong>
      <span>${escapeHtml(message)}</span>
      <small>当前 key：${amapConfig.key ? `${amapConfig.key.slice(0, 6)}...${amapConfig.key.slice(-4)}` : "未读取"} / securityJsCode：${amapConfig.securityJsCode ? "已读取" : "未填写"}</small>
    </div>
  `;
}

function ensureAmapScript() {
  if (typeof AMap !== "undefined") return Promise.resolve(window.AMap);
  if (AMapScriptPromise) return AMapScriptPromise;
  AMapScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const params = new URLSearchParams({
      v: "2.0",
      key: amapConfig.key,
      plugin: "AMap.Scale,AMap.ToolBar,AMap.Geocoder,AMap.PlaceSearch",
    });
    script.src = `https://webapi.amap.com/maps?${params.toString()}`;
    script.async = true;
    script.onload = () => {
      if (typeof AMap !== "undefined") resolve(window.AMap);
      else reject(new Error("高德脚本已加载，但 window.AMap 未注入。"));
    };
    script.onerror = () => reject(new Error("高德 JSAPI 脚本加载失败，请检查网络、Key 服务类型和高德控制台域名白名单。"));
    document.head.append(script);
  });
  return AMapScriptPromise;
}

async function loadAmap() {
  if (AMapRuntime) return AMapRuntime;
  if (!amapConfig.key) {
    throw new Error("未读取到 AMAP_KEY，请通过 node server.mjs 打开 http://localhost:4174。");
  }
  if (amapConfig.securityJsCode) {
    window._AMapSecurityConfig = {
      securityJsCode: amapConfig.securityJsCode,
    };
  }
  try {
    AMapRuntime = await ensureAmapScript();
    return AMapRuntime;
  } catch (error) {
    throw new Error(error?.message || error?.info || error?.toString?.() || "高德 JSAPI 初始化失败。");
  }
}

function mapPosition(item) {
  return [item.lng, item.lat];
}

function focusMap(map, item, zoom = 6) {
  if (!map || !item) return;
  map.setZoomAndCenter(item.isConceptPlace ? Math.min(zoom, 5) : zoom, mapPosition(item), false, 420);
}

function songsForDestination(item) {
  if (!item) return [];
  return songs.filter((song) => {
    const places = song.places || [];
    return places.some((place) =>
      item.name === place ||
      item.displayName.includes(place) ||
      place.includes(item.name)
    ) || (item.songs || []).includes(song.title);
  });
}

function primarySongForDestination(item) {
  return songsForDestination(item)[0] || null;
}

function destinationSearchText(item) {
  const relatedSongs = songsForDestination(item)
    .map((song) => [song.title, song.artist, song.album, song.lyric, song.notes, (song.places || []).join(" ")].join(" "))
    .join(" ");
  const guideText = [
    ...Object.values(item.recommendations || {}).flat().map((row) => [row.name, row.area, row.reason, row.bestFor].join(" ")),
    ...(item.readingRecommendations || []).map((book) => [book.title, book.author, book.note].join(" ")),
    ...(item.route || []).map((step) => typeof step === "string" ? step : [step.title, step.area, step.morning, step.afternoon, step.evening, step.note].join(" ")),
    ...(item.approvedGuides || []).map((row) => [row.name, row.title, row.author, row.area, row.body, row.reason].join(" ")),
  ].join(" ");
  return `${item.displayName} ${item.name} ${item.continent} ${(item.songs || []).join(" ")} ${(item.lyricLines || []).join(" ")} ${item.intro} ${relatedSongs} ${guideText}`.toLowerCase();
}

function visibleDestinations() {
  return destinations.filter((item) => {
    const continentOk =
      activeContinent === "all" ||
      item.continent === activeContinent ||
      (activeContinent === "意象" && item.isConceptPlace);
    return continentOk && destinationSearchText(item).includes(activeQuery);
  });
}

function installFlightNavigation() {
  const loader = document.createElement("div");
  loader.className = "flight-loader";
  loader.innerHTML = `
    <div class="flight-paper">
      <div class="flight-stamp">BOARDING</div>
      <svg class="flight-route" viewBox="0 0 640 220" aria-hidden="true">
        <path d="M32 168 C 156 18, 336 258, 608 58" />
      </svg>
      <span class="plane">✈</span>
    </div>
  `;
  document.body.append(loader);

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href]");
    if (!link) return;
    if (link.target === "_blank" || link.hasAttribute("download")) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const url = new URL(link.href, window.location.href);
    const isSamePageHash = url.pathname === window.location.pathname && url.hash;
    if (url.origin !== window.location.origin || isSamePageHash) return;

    event.preventDefault();
    document.body.classList.add("is-loading");
    window.setTimeout(() => {
      window.location.href = url.href;
    }, 850);
  });
}

function updateHomePostcard(item) {
  if (!item) return;
  const song = primarySongForDestination(item);
  setImage(document.querySelector("[data-postcard-image]"), item.postcardImage, `${item.displayName} 明信片`);
  document.querySelector("[data-postcard-title]").textContent = item.displayName;
  document.querySelector("[data-postcard-intro]").textContent = item.intro;
  document.querySelector("[data-postcard-lyric]").textContent = item.lyricLines[0] || "";
  document.querySelector("[data-postcard-link]").href = destinationUrl(item);
  const sourceRows = [
    `图片：${sourceLink(item.imageCredit) || "本地图片"}`,
    song ? `歌词：${sourceLink(song.factSource) || escapeHtml(song.title)}` : "",
    song ? `歌曲：${escapeHtml(song.title)} · ${escapeHtml(song.artist || "待补充歌手")}` : "",
  ].filter(Boolean);
  document.querySelector("[data-postcard-source]").innerHTML = sourceRows.join("<br>");
  const sceneSlot = document.querySelector("[data-postcard-movie]");
  if (sceneSlot) {
    sceneSlot.innerHTML = [
      movieSceneCard(item),
      song ? `<a class="song-route-chip" href="./songs.html?song=${encodeURIComponent(song.id)}">查看一首歌的路径</a>` : "",
    ].join("");
  }
}

function continentById(id) {
  return continents.find((item) => item.id === id) || continents[0];
}

function luggageMarkerContent(item) {
  return `
    <div class="atlas-marker">
      <i aria-hidden="true"></i>
      <img src="${item.postcardImage}" alt="">
      <span>${escapeHtml(item.name)}</span>
    </div>
  `;
}

function renderHomeMarkers() {
  if (!homeMap || !AMapRuntime) return;
  if (homeMarkers.length) {
    homeMap.remove(homeMarkers);
    homeMarkers = [];
  }
  homeMarkers = visibleDestinations().map((item) => {
    const marker = new AMapRuntime.Marker({
      position: mapPosition(item),
      content: luggageMarkerContent(item),
      offset: new AMapRuntime.Pixel(-58, -80),
    });
    marker.on("click", () => updateHomePostcard(item));
    return marker;
  });
  if (homeMarkers.length) homeMap.add(homeMarkers);
}

function renderHomeList() {
  const list = document.querySelector("[data-home-list]");
  if (!list) return;
  const rows = visibleDestinations();
  list.innerHTML = rows.length ? rows.map((item) => `
    <button type="button" data-home-place="${item.id}">
      <img src="${item.postcardImage}" alt="">
      <span>${escapeHtml(item.name)}</span>
    </button>
  `).join("") : `<p class="empty-inline">没有找到相关地点、歌曲或歌词。</p>`;
  list.querySelectorAll("[data-home-place]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = byId.get(button.dataset.homePlace);
      updateHomePostcard(item);
      focusMap(homeMap, item, 6);
    });
  });
}

function applyHomeFilter(fit = false) {
  renderHomeMarkers();
  renderHomeList();
  if (!homeMap) return;
  const focus = continentById(activeContinent);
  if (fit) {
    homeMap.setZoomAndCenter(focus.zoom, [focus.center[1], focus.center[0]], false, 420);
  }
}

async function initHome() {
  const mapEl = document.getElementById("worldMap");
  if (!mapEl) return;

  const tabs = document.querySelector("[data-continent-tabs]");
  tabs.innerHTML = continents.map((item) => `<button type="button" data-continent="${item.id}" class="${item.id === "all" ? "active" : ""}">${item.label}</button>`).join("");

  try {
    const AMap = await loadAmap();
    homeMap = new AMap.Map(mapEl, {
      viewMode: "2D",
      zoom: 2,
      center: [40, 22],
      resizeEnable: true,
      mapStyle: amapConfig.style || "amap://styles/macaron",
    });
    homeMap.addControl(new AMap.Scale());
    homeMap.addControl(new AMap.ToolBar({ position: "RB" }));
  } catch (error) {
    showMapSetup(mapEl, `${error.message} 如果 key 是 2021-12-02 后申请的，请在 config.local.json 写入 securityJsCode，并在高德控制台允许 localhost。`);
  }

  updateHomePostcard(destinations[0]);
  applyHomeFilter(false);

  document.querySelectorAll("[data-continent]").forEach((button) => {
    button.addEventListener("click", () => {
      activeContinent = button.dataset.continent;
      document.querySelectorAll("[data-continent]").forEach((item) => item.classList.toggle("active", item === button));
      applyHomeFilter(true);
      const first = visibleDestinations()[0];
      if (first) updateHomePostcard(first);
    });
  });

  document.querySelector("[data-search]")?.addEventListener("input", (event) => {
    activeQuery = event.target.value.trim().toLowerCase();
    applyHomeFilter(false);
  });
}

function getCurrentDestination() {
  const id = new URLSearchParams(window.location.search).get("id");
  return byId.get(id) || destinations[0];
}

function userGuideEntries(item, section) {
  const fromGuides = customGuideState.items
    .filter((entry) => entry.destinationId === item.id && entry.section === section)
    .map((entry) => ({ ...entry, origin: "custom" }));
  const fromContributions = contributionState.items
    .filter((entry) => entry.type === "destination" && entry.destinationId === item.id && entry.section === section)
    .map((entry) => ({ ...entry, origin: "contribution" }));
  return [...fromGuides, ...fromContributions].sort((a, b) => b.createdAt - a.createdAt);
}

function guideDateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "刚刚"
    : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function userGuideAction(entry) {
  if (entry.origin === "official") {
    return `
      <button type="button" class="text-action" data-copy-guide-item="${escapeHtml(entry.id)}">复制到我的攻略</button>
      <button type="button" class="text-action" data-hide-guide-item="${escapeHtml(entry.id)}">隐藏</button>
    `;
  }
  if (entry.origin === "approved" || entry.origin === "submission") {
    return `<span class="guide-lock-note">已收录投稿</span>`;
  }
  return `<button type="button" class="text-action danger" data-delete-user-guide="${escapeHtml(entry.id)}" data-user-guide-source="${entry.origin === "contribution" ? "contribution" : "custom"}">删除</button>`;
}

function officialRecommendationRows(item, kind) {
  return (item.recommendations[kind] || []).map((row, index) => ({
    ...row,
    id: row.id || officialGuideId(item.id, kind, index),
    origin: "official",
    section: kind,
    locked: true,
    curatorLabel: row.curatorLabel || "创作者倾情制作",
  }));
}

function customRecommendationRows(item, kind) {
  const approved = (item.approvedGuides || [])
    .filter((entry) => entry.section === kind)
    .map((entry) => ({
      ...entry,
      origin: entry.origin === "submission" ? "approved" : entry.origin,
      bestFor: "已收录投稿",
      verification: entry.verification || "用户投稿已通过审核；公开收录前已做基础核验。",
      source: entry.source || { sourceName: "用户投稿来源", sourceUrl: entry.sourceUrl },
    }));
  return [...approved, ...userGuideEntries(item, kind).map((entry) => ({
    id: entry.id,
    origin: entry.origin,
    section: kind,
    name: entry.title || `${customGuideMeta[kind].label}节点`,
    area: entry.author || `${item.displayName} · 用户添加`,
    reason: entry.body || "用户自己补充的攻略节点。",
    bestFor: entry.origin === "contribution" ? "用户投稿 / 待收录" : "用户新增",
    verification: `${entry.origin === "contribution" ? "投稿" : "添加"}于 ${guideDateLabel(entry.createdAt)}；公开收录前仍建议打开来源核验。`,
    lat: entry.lat,
    lng: entry.lng,
    source: {
      sourceName: entry.origin === "contribution" ? "用户投稿来源" : "用户添加来源",
      sourceUrl: entry.sourceUrl,
    },
  }))];
}

function renderRecommendations(item) {
  const board = document.querySelector("[data-recommendation-board]");
  if (!board) return;
  const order = ["eat", "stay", "move", "shop"];
  board.innerHTML = order.map((kind) => `
    <section class="guide-card ${kind}">
      <div class="guide-card-head">
        <h3><span>${customGuideMeta[kind].icon}</span>${customGuideMeta[kind].label}</h3>
        <button type="button" class="inline-panel-action" data-preset-guide-section="${kind}">添加</button>
      </div>
      ${[
        ...officialRecommendationRows(item, kind).filter((row) => !isHiddenGuide(row.id)),
        ...customRecommendationRows(item, kind),
      ].map((row) => `
        <article class="${row.origin === "official" ? "" : "user-guide-entry"}">
          ${row.origin === "official" ? contributionBadge(row.curatorLabel || "创作者倾情制作") : row.origin === "contribution" ? contributionBadge() : row.origin === "custom" ? contributionBadge("用户添加") : contributionBadge("已收录投稿")}
          <strong>${escapeHtml(row.name)}</strong>
          <p class="guide-area">${escapeHtml(row.area)}</p>
          <p>${escapeHtml(row.reason)}</p>
          <small class="guide-fit">${escapeHtml(row.bestFor)}</small>
          <small>${escapeHtml(row.verification)}</small>
          ${sourceChip(row.source?.sourceUrl, row.source?.sourceName)}
          <div class="guide-actions">${userGuideAction(row)}</div>
        </article>
      `).join("")}
    </section>
  `).join("");
}

function renderReadingRecommendations(item) {
  const list = document.querySelector("[data-reading-list]");
  if (!list) return;
  const officialBooks = (item.readingRecommendations || []).map((book, index) => ({
    ...book,
    id: officialGuideId(item.id, "reading", index),
    origin: "official",
  }));
  const userBooks = userGuideEntries(item, "reading").map((entry) => ({
    id: entry.id,
    origin: entry.origin,
    title: entry.title || "未命名读物",
    author: entry.author || "用户补充",
    note: entry.body || "用户自己补充的阅读推荐。",
    source: {
      sourceName: entry.origin === "contribution" ? "用户投稿来源" : "用户添加来源",
      sourceUrl: entry.sourceUrl,
    },
    createdAt: entry.createdAt,
  }));
  const approvedBooks = (item.approvedGuides || [])
    .filter((entry) => entry.section === "reading")
    .map((entry) => ({
      id: entry.id,
      origin: "approved",
      title: entry.name || entry.title || "投稿读物",
      author: entry.author || "用户投稿",
      note: entry.body || entry.reason || "用户投稿已通过审核。",
      source: entry.source,
    }));
  const books = [...officialBooks.filter((book) => !isHiddenGuide(book.id)), ...approvedBooks, ...userBooks];
  list.innerHTML = books.length
    ? books.map((book) => `
      <article class="reading-card ${book.origin === "official" ? "" : "user-guide-entry"}">
        <span class="reading-mark">${book.origin === "official" ? "官方" : book.origin === "approved" ? "收录" : book.origin === "contribution" ? "投稿" : "我的"}</span>
        <h3>《${escapeHtml(book.title)}》</h3>
        <p class="reading-author">${escapeHtml(book.author)}</p>
        <p>${escapeHtml(book.note)}</p>
        ${sourceChip(book.source?.sourceUrl, book.source?.sourceName)}
        <div class="guide-actions">${userGuideAction(book)}</div>
      </article>
    `).join("")
    : `<p class="source-line">这个目的地暂未添加阅读推荐。</p>`;
}

function renderRouteList(item) {
  const list = document.querySelector("[data-route-list]");
  if (!list) return;
  const officialRoutes = item.route.map((step, index) => {
    if (typeof step === "string") {
      return {
        id: officialGuideId(item.id, "route", index),
        origin: "official",
        title: step,
        area: item.displayName,
        morning: step,
        afternoon: "",
        evening: "",
        note: "",
        source: null,
      };
    }
    return {
      ...step,
      id: officialGuideId(item.id, "route", index),
      origin: "official",
    };
  });
  const userRoutes = userGuideEntries(item, "route").map((entry) => ({
    id: entry.id,
    origin: entry.origin,
    day: entry.origin === "contribution" ? "投稿" : "我的",
    title: entry.title || "自定义路线",
    area: entry.author || item.displayName,
    morning: entry.body || "用户补充的路线说明。",
    afternoon: entry.lat !== null && entry.lng !== null ? `${entry.lat}, ${entry.lng}` : "未标记坐标",
    evening: entry.origin === "contribution" ? "用户投稿 / 待收录" : "用户新增",
    note: entry.origin === "contribution" ? "这条路线已进入本地投稿预览。" : "这条路线保存在当前浏览器。",
    source: { sourceName: entry.origin === "contribution" ? "用户投稿来源" : "用户添加来源", sourceUrl: entry.sourceUrl },
  }));
  const approvedRoutes = (item.approvedGuides || [])
    .filter((entry) => entry.section === "route")
    .map((entry) => ({
      id: entry.id,
      origin: "approved",
      day: "收录",
      title: entry.name || entry.title || "投稿路线",
      area: entry.area || item.displayName,
      morning: entry.body || entry.reason || "用户投稿路线已通过审核。",
      afternoon: entry.lat !== null && entry.lng !== null ? `${entry.lat}, ${entry.lng}` : "未标记坐标",
      evening: "已收录投稿",
      note: entry.verification || "出发前仍建议打开来源核验。",
      source: entry.source,
    }));
  list.innerHTML = [...officialRoutes.filter((step) => !isHiddenGuide(step.id)), ...approvedRoutes, ...userRoutes].map((step) => {
    if (typeof step === "string") return `<li>${escapeHtml(step)}</li>`;
    return `
      <li class="route-day-card ${step.origin === "official" ? "" : "user-guide-entry"}">
        <div class="route-day-head">
          <span>${step.origin === "official" ? `Day ${escapeHtml(step.day)}` : escapeHtml(step.day)}</span>
          <h3>${escapeHtml(step.title)}</h3>
        </div>
        <p class="route-area">${escapeHtml(step.area)}</p>
        <div class="route-day-grid">
          <p><strong>上午</strong>${escapeHtml(step.morning)}</p>
          <p><strong>下午</strong>${escapeHtml(step.afternoon)}</p>
          <p><strong>晚上</strong>${escapeHtml(step.evening)}</p>
        </div>
        <p class="route-note">${escapeHtml(step.note)}</p>
        ${sourceChip(step.source?.sourceUrl, step.source?.sourceName)}
        <div class="guide-actions">${userGuideAction(step)}</div>
      </li>
    `;
  }).join("");
}

function hiddenOfficialRows(item) {
  const rows = [];
  ["eat", "stay", "move", "shop"].forEach((kind) => {
    officialRecommendationRows(item, kind).forEach((row) => {
      if (isHiddenGuide(row.id)) {
        rows.push({ id: row.id, title: row.name, section: customGuideMeta[kind].label });
      }
    });
  });
  (item.readingRecommendations || []).forEach((book, index) => {
    const id = officialGuideId(item.id, "reading", index);
    if (isHiddenGuide(id)) rows.push({ id, title: `《${book.title}》`, section: "阅读" });
  });
  item.route.forEach((step, index) => {
    const id = officialGuideId(item.id, "route", index);
    if (isHiddenGuide(id)) rows.push({ id, title: typeof step === "string" ? step : step.title, section: "路线" });
  });
  return rows;
}

function renderHiddenGuides(item) {
  const panel = document.querySelector("[data-hidden-guide-panel]");
  const list = document.querySelector("[data-hidden-guide-list]");
  if (!panel || !list) return;
  if (!activeGuidePackage(item)) {
    panel.hidden = true;
    list.innerHTML = "";
    return;
  }
  const rows = hiddenOfficialRows(item);
  panel.hidden = rows.length === 0;
  list.innerHTML = rows.map((row) => `
    <article class="hidden-guide-item">
      <span>${escapeHtml(row.section)}</span>
      <strong>${escapeHtml(row.title)}</strong>
      <button type="button" class="text-action" data-restore-guide-item="${escapeHtml(row.id)}">恢复</button>
    </article>
  `).join("");
}

function renderMovieScene(item) {
  const board = document.querySelector("[data-movie-scene]");
  if (!board) return;
  board.innerHTML = item.movieScene
    ? movieSceneCard(item)
    : `<p class="source-line">这个目的地暂未添加电影场景链接。</p>`;
}

function localPinContent(kind) {
  const label = { eat: "🍜", stay: "🏨", move: "🚇", shop: "🛍", user: "＋" }[kind] || "📍";
  return `<div class="local-pin ${kind}"><span>${label}</span></div>`;
}

function localMapPins(item) {
  const officialPins = ["eat", "stay", "move", "shop"].flatMap((kind) =>
    officialRecommendationRows(item, kind)
      .filter((row) => !isHiddenGuide(row.id))
      .map((row) => ({
        kind,
        origin: "official",
        name: row.name,
        lat: row.lat,
        lng: row.lng,
        sourceUrl: row.source?.sourceUrl,
        note: row.reason,
      }))
  );
  const userPins = ["eat", "stay", "move", "shop", "reading", "route"].flatMap((section) =>
    userGuideEntries(item, section)
      .filter((entry) => entry.lat !== null && entry.lng !== null)
      .map((entry) => ({
        kind: "user",
        origin: entry.origin,
        name: entry.title || customGuideMeta[section].label,
        lat: entry.lat,
        lng: entry.lng,
        sourceUrl: entry.sourceUrl,
        note: entry.body || (entry.origin === "contribution" ? "用户投稿 / 待收录" : "用户添加"),
      }))
  );
  const approvedPins = (item.approvedGuides || [])
    .filter((entry) => entry.lat !== null && entry.lng !== null)
    .map((entry) => ({
      kind: ["eat", "stay", "move", "shop"].includes(entry.section) ? entry.section : "user",
      origin: "approved",
      name: entry.name || entry.title,
      lat: entry.lat,
      lng: entry.lng,
      sourceUrl: entry.source?.sourceUrl,
      note: entry.body || entry.reason || "已收录投稿",
    }));
  return [...officialPins, ...approvedPins, ...userPins];
}

async function renderLocalMap(item) {
  const mapEl = document.getElementById("localMap");
  if (!mapEl) return;

  const zoom = item.isConceptPlace ? 5 : 12;
  let AMap;
  try {
    AMap = await loadAmap();
  } catch (error) {
    showMapSetup(mapEl, `${error.message} 如果 key 是 2021-12-02 后申请的，请在 config.local.json 写入 securityJsCode，并在高德控制台允许 localhost。`);
    return;
  }

  if (localMapInstance?.destroy) localMapInstance.destroy();
  mapEl.innerHTML = "";
  const map = new AMap.Map(mapEl, {
    viewMode: "2D",
    zoom,
    center: mapPosition(item),
    resizeEnable: true,
    mapStyle: amapConfig.style || "amap://styles/macaron",
  });
  localMapInstance = map;
  map.addControl(new AMap.Scale());
  map.addControl(new AMap.ToolBar({ position: "RB" }));
  const infoWindow = new AMap.InfoWindow({ offset: new AMap.Pixel(0, -20) });

  localMapPins(item).forEach((pin) => {
    const marker = new AMap.Marker({
      position: [pin.lng, pin.lat],
      content: localPinContent(pin.kind),
      offset: new AMap.Pixel(-15, -15),
    });
    marker.on("click", () => {
      const source = sourceChip(pin.sourceUrl, "打开来源");
      infoWindow.setContent(`
        <strong>${escapeHtml(pin.name)}</strong>
        ${pin.origin === "official" ? "" : "<br><em>用户添加</em>"}
        <br><span>${escapeHtml(pin.note || "")}</span>
        ${source ? `<br>${source}` : ""}
      `);
      infoWindow.open(map, marker.getPosition());
    });
    map.add(marker);
  });

  const centerMarker = new AMap.Marker({
    position: mapPosition(item),
    title: item.displayName,
  });
  map.add(centerMarker);
  infoWindow.setContent(`<strong>${escapeHtml(item.displayName)}</strong>`);
  infoWindow.open(map, mapPosition(item));
}

function hasCoordinates(row) {
  return Number.isFinite(Number(row?.lat)) && Number.isFinite(Number(row?.lng));
}

function loadGeocodeCache() {
  if (geocodeCache) return geocodeCache;
  try {
    const parsed = JSON.parse(localStorage.getItem(geocodeCacheStorageKey) || "{}");
    geocodeCache = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    geocodeCache = {};
  }
  return geocodeCache;
}

function saveGeocodeCache() {
  try {
    localStorage.setItem(geocodeCacheStorageKey, JSON.stringify(loadGeocodeCache()));
  } catch {
    // Map rendering should not fail when storage is unavailable.
  }
}

function cachedGeocode(key) {
  const cached = loadGeocodeCache()[key];
  if (!cached) return null;
  const lat = Number(cached.lat);
  const lng = Number(cached.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng, source: cached.source || "cache" } : null;
}

function setCachedGeocode(key, value) {
  loadGeocodeCache()[key] = {
    lat: Number(value.lat.toFixed(6)),
    lng: Number(value.lng.toFixed(6)),
    source: value.source || "amap-geocoder",
    cachedAt: new Date().toISOString(),
  };
  saveGeocodeCache();
}

function geocodeQuery(item, row) {
  return [item.displayName, row.name || row.title, row.area]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function geocodeWithAmap(AMap, address, city) {
  return new Promise((resolve) => {
    if (!AMap?.Geocoder || !address) {
      resolve(null);
      return;
    }
    const geocoder = new AMap.Geocoder({ city: city || "全国" });
    geocoder.getLocation(address, (status, result) => {
      const location = result?.geocodes?.[0]?.location;
      if (status === "complete" && location) {
        resolve({ lat: Number(location.lat), lng: Number(location.lng), source: "amap-geocoder" });
      } else {
        resolve(null);
      }
    });
  });
}

function placeSearchWithAmap(AMap, keyword, city) {
  return new Promise((resolve) => {
    if (!AMap?.PlaceSearch || !keyword) {
      resolve(null);
      return;
    }
    const searcher = new AMap.PlaceSearch({
      city: city || "全国",
      citylimit: false,
      pageSize: 1,
      pageIndex: 1,
    });
    searcher.search(keyword, (status, result) => {
      const location = result?.poiList?.pois?.[0]?.location;
      if (status === "complete" && location) {
        resolve({ lat: Number(location.lat), lng: Number(location.lng), source: "amap-place-search" });
      } else {
        resolve(null);
      }
    });
  });
}

async function resolveGuideRowPosition(AMap, item, row) {
  if (row.origin !== "official" && hasCoordinates(row)) {
    return { lat: Number(row.lat), lng: Number(row.lng), source: "user" };
  }
  const key = `${item.id}:${row.section || ""}:${row.name || row.title || ""}`;
  const cached = cachedGeocode(key);
  if (cached) return cached;

  const query = geocodeQuery(item, row);
  const resolved =
    await placeSearchWithAmap(AMap, query, item.name) ||
    await geocodeWithAmap(AMap, query, item.name);
  if (resolved && Number.isFinite(resolved.lat) && Number.isFinite(resolved.lng)) {
    setCachedGeocode(key, resolved);
    return resolved;
  }
  if (hasCoordinates(row)) return { lat: Number(row.lat), lng: Number(row.lng), source: "fallback" };
  return null;
}

function guidePackageStatusLabel(pkg) {
  if (pkg.status === "pending") return "待审核投稿攻略";
  if (pkg.status === "rejected") return "已拒绝";
  if (pkg.origin === "official") return "官方攻略 · 创作者倾情制作";
  if (pkg.origin === "custom") return "本地预览";
  return "用户投稿攻略";
}

function normalizeGuidePackageRows(rows = [], section, item, origin = "submission") {
  return (Array.isArray(rows) ? rows : []).map((row, index) => {
    const meta = customGuideMeta[["eat", "stay", "move", "shop", "reading"].includes(section) ? section : "route"];
    const name = row.name || row.title || `${meta.label}节点`;
    return {
      ...row,
      id: row.id || `${origin}:${item.id}:${section}:${index}`,
      destinationId: item.id,
      section,
      origin,
      name,
      title: row.title || name,
      author: row.author || "",
      area: row.area || row.author || `${item.displayName} · ${name}`,
      body: row.body || row.note || row.reason || row.description || "",
      reason: row.reason || row.body || row.note || row.description || "",
      bestFor: row.bestFor || row.best_for || "",
      verification: row.verification || (origin === "official" ? "官方完整攻略内容，出发前建议打开来源再次确认。" : "用户投稿内容，公开收录前需审核。"),
      source: row.source || { sourceName: row.sourceName || "用户投稿来源", sourceUrl: row.sourceUrl || "" },
      lat: hasCoordinates(row) ? Number(row.lat) : null,
      lng: hasCoordinates(row) ? Number(row.lng) : null,
    };
  });
}

function officialGuidePackage(item) {
  const eat = officialRecommendationRows(item, "eat");
  const stay = officialRecommendationRows(item, "stay");
  const move = officialRecommendationRows(item, "move");
  const shop = officialRecommendationRows(item, "shop");
  const reading = (item.readingRecommendations || [])
    .map((book, index) => ({
      ...book,
      id: officialGuideId(item.id, "reading", index),
      name: book.title,
      title: book.title,
      section: "reading",
      origin: "official",
      body: book.note,
      reason: book.note,
      locked: true,
      curatorLabel: "创作者倾情制作",
    }));
  const sevenDayRoute = (item.route || []).map((step, index) => {
    if (typeof step === "string") {
      return {
        id: officialGuideId(item.id, "route", index),
        origin: "official",
        section: "sevenDayRoute",
        day: index + 1,
        title: step,
        area: item.displayName,
        morning: step,
        afternoon: "",
        evening: "",
        note: "",
        source: null,
      };
    }
    return { ...step, id: officialGuideId(item.id, "route", index), origin: "official", section: "sevenDayRoute" };
  });
  return {
    id: `official:${item.id}:complete`,
    destinationId: item.id,
    title: `${item.name}完整旅行攻略`,
    coverImage: item.postcardImage,
    origin: "official",
    status: "approved",
    locked: true,
    curatorLabel: "创作者倾情制作",
    summary: item.intro,
    sections: { eat, stay, move, shop, reading, sevenDayRoute },
  };
}

function approvedGuidePackages(item) {
  const groups = new Map();
  (item.approvedGuides || []).forEach((entry) => {
    const source = entry.source || {};
    const packageId = source.packageId || source._packageId || `approved:${item.id}:legacy`;
    if (!groups.has(packageId)) {
      groups.set(packageId, {
        id: packageId,
        destinationId: item.id,
        title: source.packageTitle || `${item.name}用户投稿完整攻略`,
        coverImage: source.packageCover || item.postcardImage,
        origin: "submission",
        status: "approved",
        locked: false,
        curatorLabel: "用户投稿攻略",
        summary: source.packageSummary || "审核通过的完整攻略投稿。",
        sections: { eat: [], stay: [], move: [], shop: [], reading: [], sevenDayRoute: [] },
      });
    }
    const pkg = groups.get(packageId);
    const routeKind = source.routeKind || (entry.section === "route" ? "sevenDayRoute" : entry.section);
    const section = pkg.sections[routeKind] ? routeKind : entry.section;
    if (pkg.sections[section]) pkg.sections[section].push({ ...entry, origin: "approved", source });
  });
  return [...groups.values()];
}

function customGuidePackages(item) {
  return contributionState.items
    .filter((entry) => entry.type === "guide-package" && entry.destinationId === item.id && entry.package)
    .map((entry) => {
      const pkg = entry.package || {};
      const sections = pkg.sections || {};
      return {
        id: pkg.id || entry.id,
        destinationId: item.id,
        title: pkg.title || `${item.name}投稿完整攻略`,
        coverImage: pkg.coverImage || item.postcardImage,
        origin: "custom",
        status: pkg.status || "pending",
        locked: false,
        curatorLabel: "用户投稿攻略",
        summary: pkg.summary || "",
        contributor: pkg.contributor || "",
        sourceUrl: pkg.sourceUrl || "",
        sections: {
          eat: normalizeGuidePackageRows(sections.eat, "eat", item, "submission"),
          stay: normalizeGuidePackageRows(sections.stay, "stay", item, "submission"),
          move: normalizeGuidePackageRows(sections.move, "move", item, "submission"),
          shop: normalizeGuidePackageRows(sections.shop, "shop", item, "submission"),
          reading: normalizeGuidePackageRows(sections.reading, "reading", item, "submission"),
          sevenDayRoute: normalizeGuidePackageRows(sections.sevenDayRoute, "sevenDayRoute", item, "submission"),
        },
      };
    });
}

function guidePackagesForDestination(item) {
  return [officialGuidePackage(item), ...approvedGuidePackages(item), ...customGuidePackages(item)];
}

function activeGuidePackage(item) {
  const packages = guidePackagesForDestination(item);
  if (!activeGuidePackageId) return null;
  return packages.find((pkg) => pkg.id === activeGuidePackageId) || null;
}

function guideSectionRows(pkg, section) {
  return pkg?.sections?.[section] || [];
}

function renderDestinationGuideArchive(item) {
  const archive = document.querySelector("[data-guide-archive]");
  if (!archive) return;
  const packages = guidePackagesForDestination(item);
  const current = activeGuidePackage(item);
  archive.innerHTML = `
    <div class="panel-title">
      <h2>攻略归档</h2>
      <button type="button" class="inline-panel-action" data-open-guide-drawer>投稿</button>
    </div>
    <div class="guide-package-grid">
      ${packages.map((pkg) => `
        <button type="button" class="guide-package-card ${current && pkg.id === current.id ? "active" : ""}" data-guide-package="${escapeHtml(pkg.id)}">
          <img class="guide-package-thumb" src="${escapeHtml(pkg.coverImage || item.postcardImage)}" alt="">
          <strong>${escapeHtml(pkg.title)}</strong>
          <em>${escapeHtml(guidePackageStatusLabel(pkg))}</em>
          <span class="guide-package-summary">${escapeHtml(pkg.summary || "吃住行购物、路线与阅读整合在同一份攻略里。")}</span>
        </button>
      `).join("")}
    </div>
  `;
}

renderRecommendations = function(item, pkg = activeGuidePackage(item)) {
  const board = document.querySelector("[data-recommendation-board]");
  if (!board) return;
  if (!pkg) {
    board.innerHTML = "";
    return;
  }
  const order = ["eat", "stay", "move", "shop"];
  board.innerHTML = order.map((kind) => {
    const rows = guideSectionRows(pkg, kind);
    return `
      <section class="guide-card ${kind}">
        <div class="guide-card-head">
          <h3><span>${customGuideMeta[kind].icon}</span>${customGuideMeta[kind].label}</h3>
        </div>
        ${rows.length ? rows.map((row) => `
          <article class="${row.origin === "official" ? "" : "user-guide-entry"}">
            ${row.origin === "official" ? contributionBadge(row.curatorLabel || "创作者倾情制作") : contributionBadge(row.origin === "approved" ? "已收录投稿" : "用户投稿 / 待审核")}
            <strong>${escapeHtml(row.name)}</strong>
            <p class="guide-area">${escapeHtml(row.area)}</p>
            <p>${escapeHtml(row.reason || row.body)}</p>
            <small class="guide-fit">${escapeHtml(row.bestFor)}</small>
            <small>${escapeHtml(row.verification)}</small>
            ${hasCoordinates(row) ? "" : `<small class="unmapped-note">未标点</small>`}
            ${sourceChip(row.source?.sourceUrl, row.source?.sourceName)}
          </article>
        `).join("") : `<p class="source-line">这份攻略暂未填写${customGuideMeta[kind].label}内容。</p>`}
      </section>
    `;
  }).join("");
};

renderReadingRecommendations = function(item, pkg = activeGuidePackage(item)) {
  const list = document.querySelector("[data-reading-list]");
  if (!list) return;
  if (!pkg) {
    list.innerHTML = "";
    return;
  }
  const books = guideSectionRows(pkg, "reading");
  list.innerHTML = books.length
    ? books.map((book) => `
      <article class="reading-card ${book.origin === "official" ? "" : "user-guide-entry"}">
        <span class="reading-mark">${book.origin === "official" ? "官方" : book.origin === "approved" ? "收录" : "投稿"}</span>
        <h3>《${escapeHtml(book.title || book.name)}》</h3>
        <p class="reading-author">${escapeHtml(book.author)}</p>
        <p>${escapeHtml(book.note || book.body || book.reason)}</p>
        ${sourceChip(book.source?.sourceUrl, book.source?.sourceName)}
      </article>
    `).join("")
    : `<p class="source-line">这份攻略暂未填写阅读推荐。</p>`;
};

renderRouteList = function(item, pkg = activeGuidePackage(item)) {
  const list = document.querySelector("[data-route-list]");
  if (!list) return;
  if (!pkg) {
    list.innerHTML = "";
    return;
  }
  const sevenDay = guideSectionRows(pkg, "sevenDayRoute").map((step, index) => ({
    ...step,
    day: step.day || index + 1,
    title: step.title || step.name || `Day ${index + 1}`,
    area: step.area || item.displayName,
    morning: step.morning || step.body || step.reason || "",
    afternoon: step.afternoon || "",
    evening: step.evening || "",
    note: step.note || step.reason || "",
  }));
  const routes = sevenDay;
  list.innerHTML = routes.length ? routes.map((step) => `
    <li class="route-day-card ${step.origin === "official" ? "" : "user-guide-entry"}">
      <div class="route-day-head">
        <span>Day ${escapeHtml(step.day)}</span>
        <h3>${escapeHtml(step.title)}</h3>
      </div>
      <p class="route-area">${escapeHtml(step.area)}</p>
      <div class="route-day-grid">
        <p><strong>上午</strong>${escapeHtml(step.morning)}</p>
        <p><strong>下午</strong>${escapeHtml(step.afternoon)}</p>
        <p><strong>晚上</strong>${escapeHtml(step.evening)}</p>
      </div>
      <p class="route-note">${escapeHtml(step.note)}</p>
      ${sourceChip(step.source?.sourceUrl, step.source?.sourceName)}
    </li>
  `).join("") : `<li class="source-line">这份攻略暂未填写路线。</li>`;
};

localMapPins = async function(AMap, item, pkg = activeGuidePackage(item)) {
  if (!pkg) return [];
  const sections = ["eat", "stay", "move", "shop"];
  const rows = sections.flatMap((kind) => guideSectionRows(pkg, kind)
    .map((row) => ({ ...row, section: row.section || kind, pinKind: kind })));
  const resolved = await Promise.all(rows.map(async (row) => {
    const position = await resolveGuideRowPosition(AMap, item, row);
    if (!position) return null;
    return {
      kind: row.origin === "official" ? row.pinKind : "user",
      origin: row.origin,
      name: row.name,
      lat: position.lat,
      lng: position.lng,
      sourceUrl: row.source?.sourceUrl,
      note: row.reason || row.body,
      coordinateSource: position.source,
    };
  }));
  return resolved.filter(Boolean);
};

renderLocalMap = async function(item, pkg = activeGuidePackage(item)) {
  const mapEl = document.getElementById("localMap");
  if (!mapEl) return;

  let AMap;
  try {
    AMap = await loadAmap();
  } catch (error) {
    showMapSetup(mapEl, `${error.message}；地图加载失败时仍可查看下方攻略内容。`);
    return;
  }

  if (localMapInstance?.destroy) localMapInstance.destroy();
  mapEl.innerHTML = "";
  const map = new AMap.Map(mapEl, {
    viewMode: "2D",
    zoom: item.isConceptPlace ? 5 : 12,
    center: mapPosition(item),
    resizeEnable: true,
    mapStyle: amapConfig.style || "amap://styles/macaron",
  });
  localMapInstance = map;
  map.addControl(new AMap.Scale());
  map.addControl(new AMap.ToolBar({ position: "RB" }));
  const infoWindow = new AMap.InfoWindow({ offset: new AMap.Pixel(0, -20) });
  const pins = await localMapPins(AMap, item, pkg);
  const markers = pins.map((pin) => {
    const marker = new AMap.Marker({
      position: [pin.lng, pin.lat],
      content: localPinContent(pin.kind),
      offset: new AMap.Pixel(-15, -15),
    });
    marker.on("click", () => {
      const source = sourceChip(pin.sourceUrl, "打开来源");
      infoWindow.setContent(`
        <strong>${escapeHtml(pin.name)}</strong>
        ${pin.origin === "official" ? "" : "<br><em>用户投稿</em>"}
        <br><span>${escapeHtml(pin.note || "")}</span>
        ${source ? `<br>${source}` : ""}
      `);
      infoWindow.open(map, marker.getPosition());
    });
    map.add(marker);
    return marker;
  });
  if (markers.length) {
    map.setFitView(markers, false, [48, 48, 48, 48]);
  } else {
    const centerMarker = new AMap.Marker({ position: mapPosition(item), title: item.displayName });
    map.add(centerMarker);
    infoWindow.setContent(`<strong>${escapeHtml(item.displayName)}</strong><br><span>这份攻略暂未填写可标点坐标。</span>`);
    infoWindow.open(map, mapPosition(item));
  }
};

function rerenderDestinationContent(item) {
  const pkg = activeGuidePackage(item);
  renderDestinationGuideArchive(item);
  document.querySelectorAll("[data-guide-content]").forEach((section) => {
    section.hidden = !pkg;
  });
  if (pkg) renderMovieScene(item);
  renderRecommendations(item, pkg);
  renderReadingRecommendations(item, pkg);
  renderRouteList(item, pkg);
  renderHiddenGuides(item);
  renderLocalMap(item, pkg);
}

function setInlineStatus(selector, message) {
  const target = document.querySelector(selector);
  if (target) target.textContent = message;
}

function guideFormValue(prefix, field) {
  return document.querySelector(`[data-${prefix}-${field}]`)?.value || "";
}

function guideForm(prefix) {
  return prefix === "custom"
    ? document.querySelector("[data-custom-guide-form]")
    : document.querySelector("[data-destination-contribution-form]");
}

function resetGuideForm(prefix, keepSection = true) {
  const section = guideFormValue(prefix, "section");
  guideForm(prefix)?.reset();
  if (keepSection) {
    const select = document.querySelector(`[data-${prefix}-section]`);
    if (select) select.value = section || select.value;
  }
}

function guideEntryFromForm(item, prefix) {
  const section = cleanGuideSection(guideFormValue(prefix, "section"));
  const fallbackTitle = section === "reading" ? "未命名读物" : section === "route" ? "自定义路线" : `${customGuideMeta[section].label}节点`;
  return normalizeCustomGuideItem({
    destinationId: item.id,
    section,
    title: guideFormValue(prefix, "title") || fallbackTitle,
    author: guideFormValue(prefix, "author"),
    body: guideFormValue(prefix, "body"),
    sourceUrl: guideFormValue(prefix, "url"),
    lat: guideFormValue(prefix, "lat"),
    lng: guideFormValue(prefix, "lng"),
    createdAt: Date.now(),
  });
}

function presetGuideSection(section) {
  const select = document.querySelector("[data-custom-section]");
  const panel = document.querySelector("[data-custom-guide-panel]");
  if (select) select.value = cleanGuideSection(section);
  panel?.scrollIntoView({ behavior: "smooth", block: "center" });
  document.querySelector("[data-custom-title]")?.focus();
}

function packageField(name) {
  return document.querySelector(`[data-package-${name}]`);
}

function setGuideDrawerOpen(open) {
  const drawer = document.querySelector("[data-guide-drawer]");
  if (!drawer) return;
  drawer.hidden = !open;
  document.body.classList.toggle("drawer-open", open);
  if (open) requestAnimationFrame(() => packageField("title")?.focus());
}

function parsePackagePointRows(value, section, item) {
  return String(value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [name, area, reason, sourceUrl, lat, lng] = line.split("|").map((part) => part.trim());
      return {
        id: userContentId(`${section}-${index}`),
        destinationId: item.id,
        section,
        name: name || `${customGuideMeta[section].label}节点 ${index + 1}`,
        area: area || item.displayName,
        reason: reason || "",
        body: reason || "",
        bestFor: "用户投稿完整攻略",
        verification: "待审核投稿内容，公开前由管理员核验。",
        source: { sourceName: "用户投稿来源", sourceUrl: safeExternalUrl(sourceUrl) },
        lat: cleanNumber(lat, -90, 90),
        lng: cleanNumber(lng, -180, 180),
      };
    });
}

function parsePackageReadingRows(value, item) {
  return String(value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [title, author, note, sourceUrl] = line.split("|").map((part) => part.trim());
      return {
        id: userContentId(`reading-${index}`),
        destinationId: item.id,
        section: "reading",
        title: title || `阅读推荐 ${index + 1}`,
        name: title || `阅读推荐 ${index + 1}`,
        author: author || "",
        note: note || "",
        body: note || "",
        reason: note || "",
        source: { sourceName: "用户投稿来源", sourceUrl: safeExternalUrl(sourceUrl) },
      };
    });
}

function parsePackageRouteRows(value, section, item) {
  return String(value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [day, title, area, morning, afternoon, evening, note, sourceUrl, lat, lng] = line.split("|").map((part) => part.trim());
      return {
        id: userContentId(`${section}-${index}`),
        destinationId: item.id,
        section,
        day: day || index + 1,
        title: title || `Day ${index + 1}`,
        name: title || `Day ${index + 1}`,
        area: area || item.displayName,
        morning: morning || "",
        afternoon: afternoon || "",
        evening: evening || "",
        note: note || "",
        reason: note || "",
        source: { sourceName: "用户投稿来源", sourceUrl: safeExternalUrl(sourceUrl) },
        lat: cleanNumber(lat, -90, 90),
        lng: cleanNumber(lng, -180, 180),
      };
    });
}

async function guidePackageFromContributionForm(item) {
  const coverInput = packageField("cover");
  const upload = coverInput?.files?.[0] ? await uploadFile(coverInput.files[0]) : null;
  const title = String(packageField("title")?.value || `${item.name}投稿完整攻略`).trim();
  return {
    id: userContentId("guide-package"),
    destinationId: item.id,
    title,
    coverImage: upload?.url || item.postcardImage,
    origin: "custom",
    status: "pending",
    locked: false,
    curatorLabel: "用户投稿攻略",
    contributor: String(packageField("contributor")?.value || "").trim(),
    summary: String(packageField("summary")?.value || "").trim(),
    sourceUrl: safeExternalUrl(packageField("source-url")?.value),
    sections: {
      eat: parsePackagePointRows(packageField("eat")?.value, "eat", item),
      stay: parsePackagePointRows(packageField("stay")?.value, "stay", item),
      move: parsePackagePointRows(packageField("move")?.value, "move", item),
      shop: parsePackagePointRows(packageField("shop")?.value, "shop", item),
      reading: parsePackageReadingRows(packageField("reading")?.value, item),
      sevenDayRoute: parsePackageRouteRows(packageField("seven-day-route")?.value, "sevenDayRoute", item),
    },
  };
}

function initDestinationInteractions(item) {
  if (document.body.dataset.destinationInteractionsBound) return;
  document.body.dataset.destinationInteractionsBound = "true";

  document.querySelector("[data-custom-guide-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const current = getCurrentDestination();
    const entry = guideEntryFromForm(current, "custom");
    customGuideState.items.unshift(entry);
    saveCustomGuides();
    resetGuideForm("custom");
    setInlineStatus("[data-custom-guide-status]", `已添加到我的攻略 · ${guideDateLabel(Date.now())}`);
    rerenderDestinationContent(current);
  });

  document.querySelector("[data-destination-contribution-form]")?.addEventListener("submit", async (event) => {
    if (!packageField("title")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const current = getCurrentDestination();
    try {
      const guidePackage = await guidePackageFromContributionForm(current);
      const submitted = await postJson("/api/submissions/guide", guidePackage);
      const localPackage = { ...guidePackage, id: submitted.id || guidePackage.id, status: "pending" };
      contributionState.items.unshift(normalizeContributionItem({
        id: submitted.id || guidePackage.id,
        type: "guide-package",
        destinationId: current.id,
        status: "待审核",
        package: localPackage,
        createdAt: Date.now(),
      }));
      activeGuidePackageId = localPackage.id;
      saveContributions();
      guideForm("contribution")?.reset();
      setGuideDrawerOpen(false);
      setInlineStatus("[data-destination-contribution-status]", "已提交完整攻略审核，当前以待审核卡片预览");
      rerenderDestinationContent(current);
    } catch (error) {
      setInlineStatus("[data-destination-contribution-status]", `提交失败：${error.message}`);
    }
  }, true);

  document.querySelector("[data-destination-contribution-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const current = getCurrentDestination();
    const entry = {
      ...guideEntryFromForm(current, "contribution"),
      id: userContentId("contribution"),
      type: "destination",
      status: "待收录",
    };
    try {
      const submitted = await postJson("/api/submissions/guide", {
        destinationId: entry.destinationId,
        section: entry.section,
        title: entry.title,
        author: entry.author,
        body: entry.body,
        sourceUrl: entry.sourceUrl,
        lat: entry.lat,
        lng: entry.lng,
      });
      entry.id = submitted.id || entry.id;
      contributionState.items.unshift(normalizeContributionItem(entry));
      saveContributions();
      resetGuideForm("contribution");
      setInlineStatus("[data-destination-contribution-status]", "已提交审核，当前以待收录状态预览");
      rerenderDestinationContent(current);
    } catch (error) {
      setInlineStatus("[data-destination-contribution-status]", `提交失败：${error.message}`);
    }
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-open-guide-drawer]")) {
      setGuideDrawerOpen(true);
      return;
    }

    if (event.target.closest("[data-close-guide-drawer]")) {
      setGuideDrawerOpen(false);
      return;
    }

    const guidePackageButton = event.target.closest("[data-guide-package]");
    if (guidePackageButton) {
      activeGuidePackageId = guidePackageButton.dataset.guidePackage;
      rerenderDestinationContent(getCurrentDestination());
      return;
    }

    const preset = event.target.closest("[data-preset-guide-section]");
    if (preset) {
      presetGuideSection(preset.dataset.presetGuideSection);
      return;
    }

    const copy = event.target.closest("[data-copy-guide-item]");
    if (copy) {
      const current = getCurrentDestination();
      const allOfficial = [
        ...["eat", "stay", "move", "shop"].flatMap((section) => officialRecommendationRows(current, section)),
        ...(current.readingRecommendations || []).map((book, index) => ({
          id: officialGuideId(current.id, "reading", index),
          section: "reading",
          name: book.title,
          area: book.author,
          reason: book.note,
          source: book.source,
        })),
      ];
      const row = allOfficial.find((item) => item.id === copy.dataset.copyGuideItem);
      if (row) {
        customGuideState.items.unshift(normalizeCustomGuideItem({
          destinationId: current.id,
          section: row.section,
          title: row.name,
          author: row.area,
          body: row.reason,
          sourceUrl: row.source?.sourceUrl,
          lat: row.lat,
          lng: row.lng,
          createdAt: Date.now(),
        }));
        saveCustomGuides();
        setInlineStatus("[data-custom-guide-status]", "已复制到我的攻略，可以继续改写");
        rerenderDestinationContent(current);
      }
      return;
    }

    const hide = event.target.closest("[data-hide-guide-item]");
    if (hide) {
      customGuideState.hiddenIds.add(hide.dataset.hideGuideItem);
      saveHiddenGuides();
      rerenderDestinationContent(getCurrentDestination());
      return;
    }

    const restore = event.target.closest("[data-restore-guide-item]");
    if (restore) {
      customGuideState.hiddenIds.delete(restore.dataset.restoreGuideItem);
      saveHiddenGuides();
      rerenderDestinationContent(getCurrentDestination());
      return;
    }

    const remove = event.target.closest("[data-delete-user-guide]");
    if (remove) {
      const id = remove.dataset.deleteUserGuide;
      if (remove.dataset.userGuideSource === "contribution") {
        contributionState.items = contributionState.items.filter((entry) => entry.id !== id);
        saveContributions();
      } else {
        customGuideState.items = customGuideState.items.filter((entry) => entry.id !== id);
        saveCustomGuides();
      }
      rerenderDestinationContent(getCurrentDestination());
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setGuideDrawerOpen(false);
  });

  document.querySelectorAll("[data-custom-lat], [data-contribution-lat]").forEach((input) => {
    input.placeholder = String(item.lat);
  });
  document.querySelectorAll("[data-custom-lng], [data-contribution-lng]").forEach((input) => {
    input.placeholder = String(item.lng);
  });
}

function initDestination() {
  const item = getCurrentDestination();
  document.title = `${item.displayName} · 目的地攻略`;
  setImage(document.querySelector("[data-destination-image]"), item.heroImage, item.displayName);
  document.querySelector("[data-destination-title]").textContent = item.displayName;
  document.querySelector("[data-destination-continent]").textContent = `${item.continent} / ${item.songs.join(" / ")}`;
  document.querySelector("[data-destination-intro]").textContent = item.intro;
  document.querySelector("[data-destination-lyric]").textContent = item.lyricLines.join(" / ");
  document.querySelector("[data-concept-note]").hidden = !item.isConceptPlace;
  document.querySelector("[data-image-credit]").innerHTML = `图片：${sourceLink(item.imageCredit)}`;
  document.querySelector("[data-source-list]").innerHTML = item.sources.map((src) => `<span class="source-chip">${sourceLink(src)}</span>`).join("");
  initDestinationInteractions(item);
  rerenderDestinationContent(item);
}

function initGuides() {
  const list = document.querySelector("[data-guides-list]");
  if (!list) return;
  const search = document.querySelector("[data-guides-search]");
  search?.addEventListener("input", (event) => {
    guideArchiveQuery = event.target.value.trim().toLowerCase();
    renderGuidesArchive();
  });
  renderGuidesArchive();
}

renderGuidesArchive = function() {
  const list = document.querySelector("[data-guides-list]");
  if (!list) return;
  const filtered = destinations.filter((item) => destinationSearchText(item).includes(guideArchiveQuery));
  if (!filtered.length) {
    list.innerHTML = `<div class="archive-empty">没有找到相关目的地、攻略或歌词。</div>`;
    return;
  }
  const groups = [...new Set(filtered.map((item) => item.continent))];
  list.innerHTML = groups.map((continent) => {
    const rows = filtered.filter((item) => item.continent === continent);
    return `
      <section class="continent-group">
        <div class="panel-title">
          <h2>${escapeHtml(continent)}</h2>
          <span>${rows.length} places</span>
        </div>
        <div class="guide-grid">
          ${rows.map((item) => `
            <a class="guide-tile" href="${destinationUrl(item)}">
              <img src="${item.postcardImage}" alt="">
              <div>
                <strong>${escapeHtml(item.displayName)}</strong>
                <p>${escapeHtml(item.intro)}</p>
                <small>官方完整攻略 · 创作者倾情制作</small>
                <small>${escapeHtml(item.lyricLines[0] || "")}</small>
                ${movieSceneCard(item, true)}
              </div>
            </a>
          `).join("")}
        </div>
      </section>
    `;
  }).join("");
};

function renderGuidesArchive() {
  const list = document.querySelector("[data-guides-list]");
  if (!list) return;
  const filtered = destinations.filter((item) => destinationSearchText(item).includes(guideArchiveQuery));
  if (!filtered.length) {
    list.innerHTML = `<div class="archive-empty">没有找到相关目的地、攻略或歌词。</div>`;
    return;
  }
  const groups = [...new Set(filtered.map((item) => item.continent))];
  list.innerHTML = groups.map((continent) => {
    const rows = filtered.filter((item) => item.continent === continent);
    return `
      <section class="continent-group">
        <div class="panel-title">
          <h2>${escapeHtml(continent)}</h2>
          <span>${rows.length} places</span>
        </div>
        <div class="guide-grid">
          ${rows.map((item) => `
            <a class="guide-tile" href="${destinationUrl(item)}">
              <img src="${item.postcardImage}" alt="">
              <div>
                <strong>${escapeHtml(item.displayName)}</strong>
                <p>${escapeHtml(item.intro)}</p>
                <small>官方完整攻略 · 创作者倾情制作</small>
                <small>${escapeHtml(item.lyricLines[0] || "")}</small>
                ${movieSceneCard(item, true)}
              </div>
            </a>
          `).join("")}
        </div>
      </section>
    `;
  }).join("");
}

function parsePlaces(value) {
  return String(value || "")
    .split(/[、,，/／\n]+/)
    .map((place) => place.trim())
    .filter(Boolean);
}

function renderSongCard(song, origin = "official") {
  const isPublic = origin === "official" || origin === "approved";
  const sourceUrl = isPublic ? song.factSource?.sourceUrl : song.sourceUrl;
  const sourceLabel = isPublic ? "事实来源" : "用户投稿来源";
  const routePlaces = song.places || [];
  return `
    <article class="song-card ${origin === "official" ? "" : "user-song-card"}">
      <img src="${escapeHtml(song.coverUploadUrl || song.localCover || song.cover || "./assets/journal/stamp-sheet.jpg")}" alt="${escapeHtml(song.album || "歌曲投稿")} 封面">
      <div>
        ${origin === "official" ? "" : contributionBadge(origin === "approved" ? "已收录投稿" : "用户投稿 / 待审核")}
        <p class="eyebrow">${escapeHtml(song.artist || "待补充歌手")}</p>
        <h2>${escapeHtml(song.title || "未命名歌曲")}</h2>
        <p class="album-name">${escapeHtml(song.album || "待补充专辑 / 来源")}</p>
        <blockquote>${escapeHtml(song.lyric || "暂未填写歌词片段。")}</blockquote>
        <p>${escapeHtml(song.notes || (origin === "official" ? "" : "这条歌曲投稿保存在当前浏览器，公开收录前仍需核验。"))}</p>
        <div class="tag-row">${routePlaces.map((place) => `<span>${escapeHtml(place)}</span>`).join("")}</div>
        ${routePlaces.length ? `<button type="button" class="inline-panel-action song-route-button" data-song-route="${escapeHtml(song.id)}">查看一首歌的路径</button>` : ""}
        <div class="song-sources">
          ${sourceChip(sourceUrl, sourceLabel)}
          ${isPublic ? sourceChip(song.coverSource?.sourceUrl, song.coverSource?.pending ? "封面待核验" : "封面来源") : `<button type="button" class="text-action danger" data-delete-song-contribution="${escapeHtml(song.id)}">删除投稿</button>`}
        </div>
      </div>
    </article>
  `;
}

function renderSongList() {
  const grid = document.querySelector("[data-song-grid]");
  if (!grid) return;
  const songContributions = contributionState.items
    .filter((entry) => entry.type === "song")
    .sort((a, b) => b.createdAt - a.createdAt);
  const query = songArchiveQuery;
  const matches = (song) => [song.title, song.artist, song.album, song.lyric, song.notes, (song.places || []).join(" ")]
    .join(" ")
    .toLowerCase()
    .includes(query);
  const rows = [
    ...songContributions.filter(matches).map((song) => renderSongCard(song, "contribution")),
    ...songs.filter(matches).map((song) => renderSongCard(song, song.origin === "submission" ? "approved" : "official")),
  ];
  grid.innerHTML = rows.length ? rows.join("") : `<div class="archive-empty">没有找到相关歌曲、歌手、歌词或目的地。</div>`;
}

function destinationForSongPlace(place) {
  return destinations.find((item) =>
    item.name === place ||
    item.displayName.includes(place) ||
    place.includes(item.name)
  );
}

async function renderSongRoute(song) {
  const panel = document.querySelector("[data-song-route-panel]");
  if (!panel || !song) return;
  const routeDestinations = (song.places || []).map(destinationForSongPlace).filter(Boolean);
  panel.hidden = false;
  panel.innerHTML = `
    <div class="panel-title">
      <h2>${escapeHtml(song.title)} · 一首歌的路径</h2>
      <span>${routeDestinations.length} 个地点</span>
    </div>
    <div class="song-route-layout">
      <div class="song-route-copy">
        <p>${escapeHtml(song.artist || "待补充歌手")} / ${escapeHtml(song.album || "待补充来源")}</p>
        <blockquote>${escapeHtml(song.lyric || "暂未填写歌词片段。")}</blockquote>
        <ol>
          ${routeDestinations.map((item) => `<li><a href="${destinationUrl(item)}">${escapeHtml(item.displayName)}</a><small>${escapeHtml(item.lyricLines?.[0] || "")}</small></li>`).join("")}
        </ol>
      </div>
      <div class="song-route-map" id="songRouteMap"></div>
    </div>
  `;
  if (!routeDestinations.length) return;
  try {
    const AMap = await loadAmap();
    if (songRouteMap?.destroy) songRouteMap.destroy();
    songRouteMap = new AMap.Map("songRouteMap", {
      viewMode: "2D",
      zoom: 3,
      center: mapPosition(routeDestinations[0]),
      resizeEnable: true,
      mapStyle: amapConfig.style || "amap://styles/macaron",
    });
    songRouteMarkers = routeDestinations.map((item, index) => new AMap.Marker({
      position: mapPosition(item),
      content: `<div class="song-route-pin"><span>${index + 1}</span>${escapeHtml(item.name)}</div>`,
      offset: new AMap.Pixel(-18, -34),
    }));
    songRouteMap.add(songRouteMarkers);
    if (routeDestinations.length > 1) {
      const polyline = new AMap.Polyline({
        path: routeDestinations.map(mapPosition),
        strokeColor: "#b34c3c",
        strokeWeight: 4,
        strokeOpacity: 0.78,
      });
      songRouteMap.add(polyline);
      songRouteMap.setFitView([...songRouteMarkers, polyline], false, [42, 42, 42, 42]);
    } else {
      focusMap(songRouteMap, routeDestinations[0], 6);
    }
  } catch (error) {
    document.getElementById("songRouteMap").innerHTML = `<div class="map-empty"><strong>歌曲路线地图暂未显示</strong><span>${escapeHtml(error.message)}</span></div>`;
  }
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function initSongs() {
  const search = document.querySelector("[data-song-search]");
  search?.addEventListener("input", (event) => {
    songArchiveQuery = event.target.value.trim().toLowerCase();
    renderSongList();
  });
  renderSongList();
  const selectedSongId = new URLSearchParams(window.location.search).get("song");
  if (selectedSongId) {
    const selected = songs.find((song) => song.id === selectedSongId);
    if (selected) window.setTimeout(() => renderSongRoute(selected), 120);
  }
  const form = document.querySelector("[data-song-contribution-form]");
  if (form && !form.dataset.bound) {
    form.dataset.bound = "true";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const cover = await uploadFile(document.querySelector("[data-song-cover]")?.files?.[0]);
        const entry = normalizeContributionItem({
          id: userContentId("contribution"),
          type: "song",
          title: document.querySelector("[data-song-title]")?.value || "",
          artist: document.querySelector("[data-song-artist]")?.value || "",
          album: document.querySelector("[data-song-album]")?.value || "",
          places: parsePlaces(document.querySelector("[data-song-places]")?.value || ""),
          lyric: document.querySelector("[data-song-lyric]")?.value || "",
          notes: "这条歌曲投稿已进入审核队列。",
          sourceUrl: document.querySelector("[data-song-source-url]")?.value || "",
          coverUploadUrl: cover?.url || "",
          status: "待审核",
          createdAt: Date.now(),
        });
        const submitted = await postJson("/api/submissions/song", entry);
        entry.id = submitted.id || entry.id;
        contributionState.items.unshift(entry);
        saveContributions();
        form.reset();
        setInlineStatus("[data-song-contribution-status]", "已提交审核，正在以待收录状态预览");
        renderSongList();
      } catch (error) {
        setInlineStatus("[data-song-contribution-status]", `提交失败：${error.message}`);
      }
    });
  }

  document.addEventListener("click", (event) => {
    const route = event.target.closest("[data-song-route]");
    if (route) {
      const song = [...songs, ...contributionState.items.filter((entry) => entry.type === "song")]
        .find((item) => item.id === route.dataset.songRoute);
      renderSongRoute(song);
      return;
    }
    const remove = event.target.closest("[data-delete-song-contribution]");
    if (!remove) return;
    contributionState.items = contributionState.items.filter((entry) => entry.id !== remove.dataset.deleteSongContribution);
    saveContributions();
    renderSongList();
  });
}

function loadCanvasImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function drawCoverImage(ctx, image, x, y, width, height) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  const sourceX = (image.naturalWidth - sourceWidth) / 2;
  const sourceY = (image.naturalHeight - sourceHeight) / 2;
  ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 4) {
  const chars = Array.from(text || "");
  let line = "";
  let lines = 0;
  chars.forEach((char) => {
    const next = line + char;
    if (ctx.measureText(next).width > maxWidth && line) {
      if (lines < maxLines) ctx.fillText(line, x, y + lines * lineHeight);
      line = char;
      lines += 1;
    } else {
      line = next;
    }
  });
  if (line && lines < maxLines) {
    ctx.fillText(line, x, y + lines * lineHeight);
    lines += 1;
  }
  return y + lines * lineHeight;
}

async function renderPostcardCanvas() {
  const imageEl = document.querySelector("[data-custom-image]");
  const title = document.querySelector("[data-custom-title]")?.textContent || "旅行明信片";
  const lyric = document.querySelector("[data-custom-lyric]")?.textContent || "";
  const text = document.querySelector("[data-custom-text]")?.textContent || "";
  const source = imageEl?.currentSrc || imageEl?.src || "./assets/journal/folded-map.jpg";
  const photo = await loadCanvasImage(source);

  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 1200;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#fbf7ec";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(49, 95, 127, .06)";
  for (let y = 0; y < canvas.height; y += 44) ctx.fillRect(0, y, canvas.width, 2);
  ctx.fillStyle = "rgba(179, 76, 60, .08)";
  ctx.fillRect(1040, 760, 360, 120);
  ctx.fillStyle = "rgba(255, 255, 255, .94)";
  ctx.fillRect(72, 72, 1456, 780);
  drawCoverImage(ctx, photo, 112, 112, 1376, 700);

  ctx.strokeStyle = "rgba(46, 41, 34, .22)";
  ctx.lineWidth = 3;
  ctx.strokeRect(72, 72, 1456, 780);

  ctx.fillStyle = "#b34c3c";
  ctx.font = "700 78px Arial, sans-serif";
  ctx.fillText(title, 96, 950);

  ctx.strokeStyle = "#b34c3c";
  ctx.lineWidth = 3;
  ctx.strokeRect(1138, 886, 300, 126);
  ctx.font = "700 34px Arial, sans-serif";
  ctx.fillText("AIR MAIL", 1192, 936);
  ctx.font = "24px Arial, sans-serif";
  ctx.fillText("LYRIC MAP", 1196, 976);

  ctx.fillStyle = "#5f4438";
  ctx.font = "36px Georgia, 'Noto Serif SC', serif";
  drawWrappedText(ctx, lyric, 104, 1016, 950, 48, 2);

  ctx.fillStyle = "#756a5a";
  ctx.font = "30px Arial, 'Noto Sans SC', sans-serif";
  drawWrappedText(ctx, text, 104, 1104, 1180, 42, 2);

  ctx.strokeStyle = "rgba(49, 95, 127, .42)";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(1124, 1048);
  ctx.bezierCurveTo(1208, 1014, 1296, 1110, 1448, 1044);
  ctx.stroke();
  ctx.fillStyle = "#315f7f";
  ctx.font = "44px Arial, sans-serif";
  ctx.fillText("✈", 1458, 1048);

  return canvas;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 250);
}

async function downloadPostcardPng() {
  const canvas = await renderPostcardCanvas();
  canvas.toBlob((blob) => blob && downloadBlob(blob, "travel-postcard.png"), "image/png");
}

async function canvasJpegBytes(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  return new Uint8Array(await blob.arrayBuffer());
}

function makeImagesPdf(pages) {
  const pageWidth = 720;
  const pageHeights = pages.map((page) => Math.round((page.height / page.width) * pageWidth));
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

  addString("%PDF-1.4\n");
  addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
  const pageObjectIds = pages.map((_, index) => 3 + index * 3);
  addObject(2, `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  pages.forEach((page, index) => {
    const pageId = 3 + index * 3;
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    const pageHeight = pageHeights[index];
    addObject(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im${index} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    offsets[imageId] = offset;
    addString(`${imageId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`);
    addBytes(page.bytes);
    addString("\nendstream\nendobj\n");
    const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im${index} Do\nQ`;
    addObject(contentId, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  const xrefOffset = offset;
  const objectCount = 3 + pages.length * 3;
  addString(`xref\n0 ${objectCount}\n0000000000 65535 f \n`);
  for (let i = 1; i < objectCount; i += 1) addString(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  addString(`trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return new Blob(chunks, { type: "application/pdf" });
}

function makeImagePdf(jpegBytes, imageWidth, imageHeight) {
  return makeImagesPdf([{ bytes: jpegBytes, width: imageWidth, height: imageHeight }]);
}

async function renderPostcardBackCanvas() {
  const recipient = document.querySelector("[data-postcard-recipient]")?.value || "未来的自己";
  const address = document.querySelector("[data-postcard-address]")?.value || "把这一天寄回记忆里";
  const message = document.querySelector("[data-postcard-back-message]")?.value || "愿地图、歌词和路上的风都替我保存这一刻。";
  const signature = document.querySelector("[data-postcard-signature]")?.value || "Lyrics Map";

  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 1200;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fbf7ec";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(49, 95, 127, .06)";
  for (let y = 86; y < 1110; y += 58) ctx.fillRect(96, y, 1408, 2);
  ctx.strokeStyle = "rgba(46, 41, 34, .28)";
  ctx.lineWidth = 4;
  ctx.strokeRect(72, 72, 1456, 1056);
  ctx.beginPath();
  ctx.moveTo(800, 128);
  ctx.lineTo(800, 1072);
  ctx.stroke();

  ctx.fillStyle = "#b34c3c";
  ctx.font = "700 58px Arial, 'Noto Sans SC', sans-serif";
  ctx.fillText("POSTCARD", 108, 166);
  ctx.font = "28px Arial, 'Noto Sans SC', sans-serif";
  ctx.fillText("LYRICS MAP · AIR MAIL", 110, 212);

  ctx.fillStyle = "#5f4438";
  ctx.font = "38px Georgia, 'Noto Serif SC', serif";
  drawWrappedText(ctx, message, 112, 310, 610, 58, 8);
  ctx.font = "34px Arial, 'Noto Sans SC', sans-serif";
  ctx.fillText(`— ${signature}`, 112, 956);

  ctx.strokeStyle = "#b34c3c";
  ctx.lineWidth = 4;
  ctx.strokeRect(1190, 128, 220, 160);
  ctx.font = "700 30px Arial, sans-serif";
  ctx.fillStyle = "#b34c3c";
  ctx.fillText("STAMP", 1248, 218);

  ctx.fillStyle = "#315f7f";
  ctx.font = "700 36px Arial, 'Noto Sans SC', sans-serif";
  ctx.fillText(`To: ${recipient}`, 858, 396);
  ctx.font = "30px Arial, 'Noto Sans SC', sans-serif";
  drawWrappedText(ctx, address, 858, 470, 560, 48, 4);
  ctx.strokeStyle = "rgba(49, 95, 127, .45)";
  for (let y = 552; y <= 850; y += 74) {
    ctx.beginPath();
    ctx.moveTo(858, y);
    ctx.lineTo(1420, y);
    ctx.stroke();
  }
  return canvas;
}

async function downloadPostcardPdf() {
  const front = await renderPostcardCanvas();
  const back = await renderPostcardBackCanvas();
  const pages = [
    { bytes: await canvasJpegBytes(front), width: front.width, height: front.height },
    { bytes: await canvasJpegBytes(back), width: back.width, height: back.height },
  ];
  downloadBlob(makeImagesPdf(pages), "travel-postcard.pdf");
}

function initPostcard() {
  const select = document.querySelector("[data-postcard-destination]");
  const image = document.querySelector("[data-custom-image]");
  const title = document.querySelector("[data-custom-title]");
  const lyric = document.querySelector("[data-custom-lyric]");
  const text = document.querySelector("[data-custom-text]");
  const textarea = document.querySelector("[data-postcard-text]");
  const backFields = [
    "[data-postcard-recipient]",
    "[data-postcard-address]",
    "[data-postcard-back-message]",
    "[data-postcard-signature]",
  ];
  if (!select || !image) return;

  select.innerHTML = destinations.map((item) => `<option value="${item.id}">${escapeHtml(item.displayName)}</option>`).join("");

  function render() {
    const item = byId.get(select.value) || destinations[0];
    if (!image.dataset.customSrc) setImage(image, item.postcardImage, item.displayName);
    title.textContent = item.displayName;
    lyric.textContent = item.lyricLines[0] || "";
    text.textContent = textarea.value;
    document.querySelector("[data-back-recipient]").textContent = document.querySelector("[data-postcard-recipient]")?.value || "未来的自己";
    document.querySelector("[data-back-address]").textContent = document.querySelector("[data-postcard-address]")?.value || "把这一天寄回记忆里";
    document.querySelector("[data-back-message]").textContent = document.querySelector("[data-postcard-back-message]")?.value || "愿地图、歌词和路上的风都替我保存这一刻。";
    document.querySelector("[data-back-signature]").textContent = document.querySelector("[data-postcard-signature]")?.value || "Lyrics Map";
  }

  select.addEventListener("change", () => {
    image.dataset.customSrc = "";
    render();
  });
  textarea.addEventListener("input", render);
  backFields.forEach((selector) => document.querySelector(selector)?.addEventListener("input", render));
  document.querySelector("[data-postcard-upload]").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      image.dataset.customSrc = "1";
      setImage(image, reader.result, "用户上传的旅行图片");
    };
    reader.readAsDataURL(file);
  });
  document.querySelector('[data-export-postcard="png"]')?.addEventListener("click", downloadPostcardPng);
  document.querySelector('[data-export-postcard="pdf"]')?.addEventListener("click", downloadPostcardPdf);
  render();
}

function initAi() {
  const select = document.querySelector("[data-ai-destination]");
  const output = document.querySelector("[data-ai-output]");
  if (!select || !output) return;

  select.innerHTML = destinations.map((item) => `<option value="${item.displayName}">${escapeHtml(item.displayName)}</option>`).join("");

  document.querySelectorAll("[data-ai-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const payload = {
        mode: button.dataset.aiAction,
        destination: select.value,
        days: document.querySelector("[data-ai-days]").value,
        budget: document.querySelector("[data-ai-budget]").value,
        style: document.querySelector("[data-ai-style]").value,
      };
      const prompt = payload.mode === "playlist"
        ? `你是 Lyrics Map 的旅行歌单策划助手。Lyrics Map 是一个把歌词、目的地和旅行手帐连接起来的产品；当前数据专题以陈绮贞相关歌曲为主，但歌单不需要局限于陈绮贞。
请根据以下信息生成一份个性化旅行歌单。
目的地：${payload.destination}
天数：${payload.days}
预算：${payload.budget}
喜欢的类型 / 风格：${payload.style}

输出要求：
1. 用中文输出，语气温柔、文艺、可执行。
2. 给 8-12 首歌，避免只堆同一位歌手；可包含华语、日语、英语或当地语种歌曲。
3. 每首歌必须包含：歌曲名、歌手、适合播放的旅行场景、与目的地 / 歌词地图的关联、推荐理由。
4. 结尾补一段“播放顺序建议”，说明适合出发、抵达、傍晚、夜游或返程的顺序。
5. 不要编造不存在的歌曲、歌词或专辑信息；不确定时用“可替换为同气质歌曲”说明。
6. 如模型具备联网能力，请核验歌曲基础信息，并标注需要用户再确认的平台版权或地区可听性。`
        : `你是 Lyrics Map 的旅行助手。请根据以下信息生成旅行建议。
目的地：${payload.destination}
天数：${payload.days}
预算：${payload.budget}
喜欢的类型 / 风格：${payload.style}

要求：
1. 用中文输出，语气温柔、文艺、可执行。
2. 如果生成旅行建议，请按上午 / 下午 / 晚上 / 注意事项整理。
3. 如模型具备联网能力，请先核验当前营业、交通、天气或活动信息，并标注“需出发前再确认”的项目。
4. 可参考 Lyrics Map 的气质：歌词、地图、书信、明信片、慢游、城市夜色、海边、火车、公路。`;

      output.textContent = `正在连接 ${aiConfig.provider || "DeepSeek / 豆包"} API...\n\n${prompt}`;
      try {
        const response = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, mode: payload.mode, destination: payload.destination }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "AI API 暂不可用");
        output.textContent = result.text || "AI 没有返回内容。";
      } catch (error) {
        try {
          await navigator.clipboard.writeText(prompt);
          output.textContent = `${prompt}\n\n${error.message}。已复制提示词，可粘贴到 DeepSeek / 豆包官网对话继续。`;
        } catch {
          output.textContent = `${prompt}\n\n${error.message}。浏览器未允许自动复制，请手动复制以上提示词。`;
        }
      }
    });
  });
}

function formatDate(value, offset) {
  if (!value) return `第 ${offset + 1} 天`;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return `第 ${offset + 1} 天`;
  date.setDate(date.getDate() + offset);
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", weekday: "short" });
}

const packingStorageKey = "lyrics-map-packing-v1";
const defaultPackingGroups = [
  { title: "随身 👕", tone: "rose", items: ["贴身衣物", "外套", "洗发水", "护肤用品", "防晒霜", "现金", "墨镜/帽子", "书籍/本子/笔"] },
  { title: "证件 🪪", tone: "green", items: ["身份证", "护照", "学生证", "银行卡", "机票/车票", "酒店确认单"] },
  { title: "其他 🌼", tone: "gold", items: ["背包", "相机/CCD", "耳机", "充电器", "遮阳伞/雨伞", "驱蚊水", "小风扇", "露营灯"] },
];
const packingState = {
  groups: [],
};

function packingId() {
  return `packing-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function defaultPackingState() {
  return defaultPackingGroups.map((group, groupIndex) => ({
    id: `default-${groupIndex}`,
    title: group.title,
    tone: group.tone,
    items: group.items.map((text, itemIndex) => ({
      id: `default-${groupIndex}-${itemIndex}`,
      text,
      checked: false,
    })),
  }));
}

function normalizePackingGroup(group, index) {
  return {
    id: group?.id || packingId(),
    title: group?.title || `分类 ${index + 1}`,
    tone: group?.tone || ["rose", "green", "gold"][index % 3],
    items: Array.isArray(group?.items)
      ? group.items.map((item) => typeof item === "object"
        ? { id: item.id || packingId(), text: item.text || "", checked: !!item.checked }
        : { id: packingId(), text: String(item || ""), checked: false })
      : [],
  };
}

function loadPackingState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(packingStorageKey) || "[]");
    return Array.isArray(parsed) && parsed.length
      ? parsed.map(normalizePackingGroup)
      : defaultPackingState();
  } catch {
    return defaultPackingState();
  }
}

function savePackingState() {
  localStorage.setItem(packingStorageKey, JSON.stringify(packingState.groups));
}

function blankCell(label, lines = 2) {
  return `<div class="handwrite-cell" contenteditable="true" data-placeholder="${label}" style="--lines:${lines}"></div>`;
}

function ledgerRow(label = "", amount = "") {
  return `
    <div class="ledger-row">
      <input type="text" placeholder="项目，例如咖啡 / 地铁" value="${escapeHtml(label)}">
      <input class="bill-amount" type="number" min="0" step="0.01" placeholder="¥" value="${escapeHtml(amount)}">
      <button type="button" aria-label="删除账单" data-remove-row>×</button>
    </div>
  `;
}

const memoStorageKey = "cheer-travel-memos-v2";
const memoKinds = {
  text: { label: "文字", icon: "✍", tag: "攻略" },
  link: { label: "链接", icon: "🔗", tag: "攻略" },
  checklist: { label: "清单", icon: "☑", tag: "物品" },
  photo: { label: "照片", icon: "📸", tag: "拍照" },
};
const memoPlatformIcons = {
  小红书: "小",
  B站: "B",
  抖音: "抖",
  微博: "微",
  豆瓣: "豆",
  地图: "图",
  Mocation: "影",
  Instagram: "IG",
  YouTube: "YT",
  通用链接: "↗",
};
const memoState = {
  filter: "all",
  sort: "newest",
  items: [],
};

function memoId() {
  return `memo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function safeMemoUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "#";
  } catch {
    return "#";
  }
}

function memoHost(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "travel note";
  }
}

function detectMemoPlatform(value) {
  const host = memoHost(value).toLowerCase();
  if (host.includes("xiaohongshu.com")) return { platform: "小红书", tag: "拍照" };
  if (host.includes("bilibili.com") || host.includes("b23.tv")) return { platform: "B站", tag: "拍照" };
  if (host.includes("douyin.com")) return { platform: "抖音", tag: "拍照" };
  if (host.includes("weibo.com")) return { platform: "微博", tag: "攻略" };
  if (host.includes("douban.com")) return { platform: "豆瓣", tag: "阅读" };
  if (host.includes("mocation.cc")) return { platform: "Mocation", tag: "拍照" };
  if (host.includes("google.com") || host.includes("amap.com") || host.includes("maps")) return { platform: "地图", tag: "攻略" };
  if (host.includes("instagram.com")) return { platform: "Instagram", tag: "拍照" };
  if (host.includes("youtube.com") || host.includes("youtu.be")) return { platform: "YouTube", tag: "拍照" };
  return { platform: "通用链接", tag: "攻略" };
}

function normalizeMemoUrl(value) {
  const raw = value.trim();
  if (!raw) return "";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return safeMemoUrl(withProtocol);
}

function createMemo(type = "text", overrides = {}) {
  const kind = memoKinds[type] || memoKinds.text;
  const createdAt = Date.now();
  const base = {
    id: memoId(),
    type,
    title: `${kind.label}备忘`,
    body: "",
    url: "",
    platform: "",
    tag: kind.tag,
    rows: [],
    image: "",
    createdAt,
  };
  if (type === "text") {
    base.title = "旅行灵感";
    base.body = "写攻略、拍照灵感、临时提醒……";
  }
  if (type === "checklist") {
    base.title = "行李清单";
    base.rows = [
      { text: "身份证 / 护照", checked: false },
      { text: "相机、充电器、耳机", checked: false },
      { text: "书籍、本子、笔", checked: true },
    ];
  }
  if (type === "photo") {
    base.title = "照片灵感";
    base.body = "想拍一张贴在手帐里的街角照片。";
    base.image = "./assets/journal/memo-board-ref.png";
  }
  return { ...base, ...overrides };
}

function createMemoFromUrl(value) {
  const url = normalizeMemoUrl(value);
  if (!url || url === "#") return null;
  const meta = detectMemoPlatform(url);
  const host = memoHost(url);
  return createMemo("link", {
    title: `${meta.platform}灵感卡`,
    body: `来自 ${host} 的旅行线索，可作为攻略、机位或阅读资料继续整理。`,
    url,
    platform: meta.platform,
    tag: meta.tag,
    image: meta.platform === "小红书" ? "./assets/journal/memo-board-ref.png" : "./assets/journal/folded-map.jpg",
  });
}

async function createMemoFromUrlWithPreview(value) {
  const fallback = createMemoFromUrl(value);
  if (!fallback) return null;
  try {
    const preview = await apiJson(`/api/link-preview?url=${encodeURIComponent(fallback.url)}`);
    return createMemo("link", {
      title: preview.title || fallback.title,
      body: preview.description || fallback.body,
      url: fallback.url,
      platform: preview.platform || fallback.platform,
      tag: preview.tag || fallback.tag,
      image: preview.imageUrl || fallback.image,
    });
  } catch {
    return fallback;
  }
}

function defaultMemoItems() {
  return [
    createMemoFromUrl("https://www.xiaohongshu.com/search_result?keyword=%E6%97%85%E8%A1%8C%20%E6%89%8B%E5%B8%90"),
    createMemo("photo", {
      title: "照片灵感",
      body: "雨天街角、车窗、票根和一张可以贴进旅行日志的照片。",
      createdAt: Date.now() - 1,
    }),
    createMemo("checklist", {
      title: "随身物品",
      createdAt: Date.now() - 3,
    }),
    createMemo("text", {
      title: "攻略灵感",
      body: "出发前再确认天气、营业时间和交通。路上留一点空白给临时发现。",
      tag: "攻略",
      createdAt: Date.now() - 4,
    }),
  ].filter(Boolean);
}

function normalizeMemoItem(item) {
  if (item?.type === "table") {
    const legacyTableTitle = ["旅行", "表格"].join("");
    const tableText = Array.isArray(item.rows)
      ? item.rows.map((row) => Array.isArray(row) ? row.filter(Boolean).join(" / ") : String(row || "")).filter(Boolean).join("\n")
      : "";
    return {
      ...createMemo("text"),
      ...item,
      type: "text",
      title: item.title === legacyTableTitle ? "表格备忘" : (item.title || "表格备忘"),
      body: [item.body, tableText].filter(Boolean).join("\n"),
      rows: [],
    };
  }
  const type = memoKinds[item?.type] ? item.type : "text";
  return {
    ...createMemo(type),
    ...item,
    id: item?.id || memoId(),
    type,
    title: item?.title || memoKinds[type].label,
    tag: item?.tag || memoKinds[type].tag,
    rows: Array.isArray(item?.rows) ? item.rows : [],
    createdAt: Number(item?.createdAt) || Date.now(),
  };
}

function loadMemoItems() {
  try {
    const parsed = JSON.parse(localStorage.getItem(memoStorageKey) || "[]");
    return Array.isArray(parsed) && parsed.length ? parsed.map(normalizeMemoItem) : defaultMemoItems();
  } catch {
    return defaultMemoItems();
  }
}

function saveMemoItems() {
  localStorage.setItem(memoStorageKey, JSON.stringify(memoState.items));
}

function memoImageFromFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) {
      reject(new Error("请选择图片文件。"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("图片读取失败。"));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("图片解析失败。"));
      image.onload = () => {
        const maxSize = 1200;
        const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", .82));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function memoDateLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function memoNoteBody(item) {
  if (item.type === "link") {
    const href = safeMemoUrl(item.url);
    const platform = item.platform || detectMemoPlatform(href).platform;
    return `
      <a class="memo-link-preview" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">
        <span class="memo-link-thumb">
          ${item.image ? `<img src="${escapeHtml(item.image)}" alt="">` : escapeHtml(memoPlatformIcons[platform] || "↗")}
        </span>
        <span>
          <strong>${escapeHtml(platform)}</strong>
          <small>${escapeHtml(memoHost(href))}</small>
          <em>${escapeHtml(href)}</em>
        </span>
      </a>
      <label class="memo-upload">
        <input type="file" accept="image/*" data-memo-link-image-upload>
        <span>替换预览图</span>
      </label>
      <textarea data-memo-field="body" placeholder="补充这个链接为什么值得收藏">${escapeHtml(item.body)}</textarea>
    `;
  }
  if (item.type === "checklist") {
    const rows = item.rows.length ? item.rows : createMemo("checklist").rows;
    return `
      <div class="memo-checklist">
        ${rows.map((row, index) => {
          const checked = typeof row === "object" ? row.checked : false;
          const text = typeof row === "object" ? row.text : row;
          return `
            <label>
              <input type="checkbox" data-check-index="${index}" ${checked ? "checked" : ""}>
              <span contenteditable="true" data-check-text="${index}">${escapeHtml(text || "")}</span>
              <button type="button" aria-label="删除清单项" data-remove-check-item="${index}">×</button>
            </label>
          `;
        }).join("")}
      </div>
      <button type="button" class="memo-add-check" data-add-check-item>＋ 添加清单项</button>
    `;
  }
  if (item.type === "photo") {
    return `
      <img class="memo-photo" src="${escapeHtml(item.image || "./assets/journal/memo-board-ref.png")}" alt="">
      <label class="memo-upload">
        <input type="file" accept="image/*" data-memo-photo-upload>
        <span>上传照片灵感</span>
      </label>
      <textarea data-memo-field="body" placeholder="写拍照机位、姿势、色调或参考链接">${escapeHtml(item.body)}</textarea>
    `;
  }
  return `<textarea data-memo-field="body" placeholder="写攻略、拍照灵感、临时提醒……">${escapeHtml(item.body)}</textarea>`;
}

function memoNoteCard(item) {
  const kind = memoKinds[item.type] || memoKinds.text;
  return `
    <article class="memo-note ${item.type}" data-memo-id="${escapeHtml(item.id)}">
      <div class="memo-note-head">
        <span class="memo-kind">${kind.icon} ${escapeHtml(kind.label)}</span>
        <button type="button" aria-label="删除备忘" data-remove-memo>×</button>
      </div>
      <input class="memo-title" data-memo-field="title" value="${escapeHtml(item.title)}" placeholder="标题">
      <div class="memo-note-meta">
        <select data-memo-field="tag" aria-label="备忘分类">
          ${["攻略", "拍照", "物品", "阅读"].map((tag) => `<option value="${tag}" ${item.tag === tag ? "selected" : ""}>${tag}</option>`).join("")}
        </select>
        <small>${escapeHtml(memoDateLabel(item.createdAt))}</small>
      </div>
      ${memoNoteBody(item)}
    </article>
  `;
}

function syncMemoFromCard(card) {
  const item = memoState.items.find((memo) => memo.id === card?.dataset.memoId);
  if (!item) return;
  card.querySelectorAll("[data-memo-field]").forEach((field) => {
    item[field.dataset.memoField] = field.value;
  });
  if (item.type === "checklist") {
    item.rows = [...card.querySelectorAll(".memo-checklist label")].map((label) => ({
      checked: label.querySelector("input")?.checked || false,
      text: label.querySelector("[data-check-text]")?.textContent.trim() || "",
    }));
  }
  saveMemoItems();
}

function renderMemoList() {
  const list = document.querySelector("[data-memo-list]");
  if (!list) return;
  const items = memoState.items
    .filter((item) => memoState.filter === "all" || item.tag === memoState.filter)
    .sort((a, b) => memoState.sort === "newest" ? b.createdAt - a.createdAt : a.createdAt - b.createdAt);
  list.innerHTML = items.length
    ? items.map(memoNoteCard).join("")
    : `<div class="memo-empty">还没有这个分类的备忘。</div>`;
  document.querySelectorAll("[data-memo-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.memoFilter === memoState.filter);
  });
  const sortButton = document.querySelector("[data-memo-sort]");
  if (sortButton) sortButton.textContent = memoState.sort === "newest" ? "排序：最新" : "排序：最早";
}

function addMemoItem(item) {
  if (!item) return;
  memoState.items.unshift(item);
  memoState.filter = "all";
  saveMemoItems();
  renderMemoList();
}

function renderPackingList() {
  const list = document.querySelector("[data-packing-list]");
  if (!list) return;
  list.innerHTML = packingState.groups.map((group) => `
    <section class="packing-section ${group.tone}" data-packing-group="${escapeHtml(group.id)}">
      <div class="packing-section-head">
        <h3 contenteditable="true" data-packing-title>${escapeHtml(group.title)}</h3>
        <button type="button" aria-label="删除分类" data-remove-packing-group>×</button>
      </div>
      ${group.items.map((item) => `
        <label data-packing-item="${escapeHtml(item.id)}">
          <input type="checkbox" ${item.checked ? "checked" : ""}>
          <span contenteditable="true" data-packing-text>${escapeHtml(item.text)}</span>
          <button type="button" aria-label="删除物品" data-remove-packing-item>×</button>
        </label>
      `).join("")}
      <button type="button" class="packing-add-item" data-add-packing-item>＋ 添加物品</button>
    </section>
  `).join("");
}

function syncPackingFromDom() {
  packingState.groups = [...document.querySelectorAll("[data-packing-group]")].map((section, groupIndex) => ({
    id: section.dataset.packingGroup || packingId(),
    title: section.querySelector("[data-packing-title]")?.textContent.trim() || `分类 ${groupIndex + 1}`,
    tone: ["rose", "green", "gold"][groupIndex % 3],
    items: [...section.querySelectorAll("[data-packing-item]")].map((label) => ({
      id: label.dataset.packingItem || packingId(),
      text: label.querySelector("[data-packing-text]")?.textContent.trim() || "",
      checked: label.querySelector("input")?.checked || false,
    })),
  }));
  savePackingState();
}

function addPackingItem(groupId, text = "新物品") {
  const group = packingState.groups.find((item) => item.id === groupId);
  if (!group) return;
  group.items.push({ id: packingId(), text, checked: false });
  savePackingState();
  renderPackingList();
}

function addPackingGroup() {
  const tones = ["rose", "green", "gold"];
  packingState.groups.push({
    id: packingId(),
    title: "新分类",
    tone: tones[packingState.groups.length % tones.length],
    items: [{ id: packingId(), text: "新物品", checked: false }],
  });
  savePackingState();
  renderPackingList();
}

function updateBudgetTotal() {
  const total = [...document.querySelectorAll(".bill-amount")]
    .reduce((sum, input) => sum + (Number(input.value) || 0), 0);
  const target = document.querySelector("[data-budget-total]");
  if (target) target.textContent = `合计 ¥${total.toFixed(2)}`;
}

function renderPlannerTable() {
  const destination = document.querySelector("[data-plan-destination]");
  const daysInput = document.querySelector("[data-plan-days]");
  const startInput = document.querySelector("[data-plan-start]");
  const table = document.querySelector("[data-plan-table]");
  if (!destination || !table) return;

  const item = byId.get(destination.value) || destinations[0];
  const days = Math.max(1, Math.min(14, Number(daysInput.value) || 1));
  table.innerHTML = `
    <table class="itinerary-table">
      <thead>
        <tr>
          <th>日期</th>
          <th>行程</th>
          <th>住宿</th>
          <th>购物</th>
          <th>账单</th>
          <th>旅行清单</th>
          <th>备忘</th>
        </tr>
      </thead>
      <tbody>
        ${Array.from({ length: days }, (_, index) => `
          <tr>
            <td><strong>第 ${index + 1} 天</strong><small>${escapeHtml(formatDate(startInput.value, index))}</small></td>
            <td>${blankCell("添加地点、时间、交通", 4)}</td>
            <td>${blankCell("酒店 / 民宿 / 地址", 3)}</td>
            <td>${blankCell("想买的东西、店名", 3)}</td>
            <td>${ledgerRow()}</td>
            <td>${blankCell("当天确认事项、随身物品", 3)}</td>
            <td>${blankCell("票根、心情、拍照机位", 4)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  const preview = document.querySelector("[data-plan-preview]");
  if (preview) {
    preview.innerHTML = `
      <img src="${item.postcardImage}" alt="">
      <div>
        <p class="eyebrow">itinerary</p>
        <h2>${escapeHtml(item.displayName)}</h2>
        <p>${escapeHtml(item.intro)}</p>
        ${movieSceneCard(item)}
      </div>
    `;
  }
  updateBudgetTotal();
}

async function exportPlannerPdf() {
  syncPackingFromDom();
  document.querySelectorAll(".memo-note").forEach(syncMemoFromCard);
  const title = document.querySelector("[data-plan-destination]")?.selectedOptions?.[0]?.textContent || "旅行手帐";
  const start = document.querySelector("[data-plan-start]")?.value || "未设置日期";
  const rows = [...document.querySelectorAll(".itinerary-table tbody tr")].map((tr) =>
    [...tr.children].map((cell) => cell.innerText.replace(/\s+/g, " ").trim()).filter(Boolean).join("  |  ")
  );
  const ledgers = [...document.querySelectorAll(".ledger-row")].map((row) =>
    [...row.querySelectorAll("input")].map((input) => input.value.trim()).filter(Boolean).join(" ¥")
  ).filter(Boolean);
  const memos = memoState.items.map((item) => `${item.title}：${item.body || item.url || item.tag || ""}`);
  const packing = packingState.groups.map((group) => `${group.title}：${group.items.map((item) => `${item.checked ? "✓" : "□"}${item.text}`).join(" / ")}`);
  const lines = [
    `目的地：${title}`,
    `出发日期：${start}`,
    "",
    "行程规划",
    ...rows,
    "",
    "记账",
    ...(ledgers.length ? ledgers : ["暂无账单"]),
    "",
    "备忘",
    ...(memos.length ? memos : ["暂无备忘"]),
    "",
    "打包清单",
    ...(packing.length ? packing : ["暂无清单"]),
  ];
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = Math.max(1600, 260 + lines.length * 48);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fbf7ec";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(49, 95, 127, .06)";
  for (let y = 0; y < canvas.height; y += 44) ctx.fillRect(0, y, canvas.width, 2);
  ctx.fillStyle = "#b34c3c";
  ctx.font = "700 66px Arial, 'Noto Sans SC', sans-serif";
  ctx.fillText("Lyrics Map 旅行手帐", 88, 118);
  ctx.fillStyle = "#5f4438";
  ctx.font = "30px Arial, 'Noto Sans SC', sans-serif";
  let y = 198;
  lines.forEach((line) => {
    if (!line) {
      y += 28;
      return;
    }
    const isHeading = ["行程规划", "记账", "备忘", "打包清单"].includes(line);
    ctx.fillStyle = isHeading ? "#315f7f" : "#5f4438";
    ctx.font = `${isHeading ? "700 38px" : "30px"} Arial, 'Noto Sans SC', sans-serif`;
    y = drawWrappedText(ctx, line, 88, y, 1380, isHeading ? 54 : 44, isHeading ? 1 : 3) + (isHeading ? 10 : 4);
  });
  const jpegBytes = await canvasJpegBytes(canvas);
  downloadBlob(makeImagePdf(jpegBytes, canvas.width, canvas.height), "travel-planner.pdf");
}

function initPlanner() {
  const select = document.querySelector("[data-plan-destination]");
  if (!select) return;
  select.innerHTML = destinations.map((item) => `<option value="${item.id}">${escapeHtml(item.displayName)}</option>`).join("");
  document.querySelector("[data-plan-generate]")?.addEventListener("click", renderPlannerTable);
  document.querySelector("[data-plan-export]")?.addEventListener("click", exportPlannerPdf);
  document.querySelector("[data-plan-print]")?.addEventListener("click", () => window.print());
  document.querySelector("[data-add-ledger]")?.addEventListener("click", () => {
    document.querySelector("[data-ledger-list]")?.insertAdjacentHTML("beforeend", ledgerRow());
  });
  document.querySelector("[data-add-memo]")?.addEventListener("click", () => addMemoItem(createMemo("text")));
  document.querySelectorAll("[data-add-memo-type]").forEach((button) => {
    button.addEventListener("click", () => addMemoItem(createMemo(button.dataset.addMemoType)));
  });
  const memoUrlInput = document.querySelector("[data-memo-url]");
  const addLinkMemo = async () => {
    const item = await createMemoFromUrlWithPreview(memoUrlInput?.value || "");
    if (!item) return;
    addMemoItem(item);
    memoUrlInput.value = "";
  };
  document.querySelector("[data-add-link-memo]")?.addEventListener("click", addLinkMemo);
  memoUrlInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addLinkMemo();
    }
  });
  memoUrlInput?.addEventListener("paste", () => window.setTimeout(addLinkMemo, 0));
  document.querySelectorAll("[data-memo-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      memoState.filter = button.dataset.memoFilter;
      renderMemoList();
    });
  });
  document.querySelector("[data-memo-sort]")?.addEventListener("click", () => {
    memoState.sort = memoState.sort === "newest" ? "oldest" : "newest";
    renderMemoList();
  });
  document.addEventListener("input", (event) => {
    if (event.target.matches(".bill-amount")) updateBudgetTotal();
    if (event.target.closest("[data-packing-list]")) syncPackingFromDom();
    if (event.target.closest(".memo-note")) syncMemoFromCard(event.target.closest(".memo-note"));
  });
  document.addEventListener("change", (event) => {
    if (event.target.closest("[data-packing-list]")) syncPackingFromDom();
    const photoUpload = event.target.closest("[data-memo-photo-upload], [data-memo-link-image-upload]");
    if (photoUpload) {
      const card = photoUpload.closest(".memo-note");
      const item = memoState.items.find((memo) => memo.id === card?.dataset.memoId);
      const file = photoUpload.files?.[0];
      if (!item || !file) return;
      syncMemoFromCard(card);
      memoImageFromFile(file)
        .then((image) => {
          item.image = image;
          saveMemoItems();
          renderMemoList();
        })
        .catch((error) => {
          item.body = [item.body, `图片上传失败：${error.message}`].filter(Boolean).join("\n");
          saveMemoItems();
          renderMemoList();
        });
      return;
    }
    if (event.target.closest(".memo-note")) syncMemoFromCard(event.target.closest(".memo-note"));
  });
  document.addEventListener("keydown", (event) => {
    const packingText = event.target.closest("[data-packing-text]");
    if (packingText && event.key === "Enter") {
      event.preventDefault();
      syncPackingFromDom();
      const group = packingText.closest("[data-packing-group]");
      addPackingItem(group?.dataset.packingGroup, "");
      return;
    }
    const checkText = event.target.closest("[data-check-text]");
    if (!checkText || event.key !== "Enter") return;
    event.preventDefault();
    const card = checkText.closest(".memo-note");
    const item = memoState.items.find((memo) => memo.id === card?.dataset.memoId);
    if (!item) return;
    syncMemoFromCard(card);
    item.rows.push({ text: "", checked: false });
    saveMemoItems();
    renderMemoList();
  });
  document.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-row]");
    if (remove) {
      remove.closest(".ledger-row")?.remove();
      updateBudgetTotal();
    }
    const removeMemo = event.target.closest("[data-remove-memo]");
    if (removeMemo) {
      const card = removeMemo.closest(".memo-note");
      memoState.items = memoState.items.filter((item) => item.id !== card?.dataset.memoId);
      saveMemoItems();
      renderMemoList();
    }
    const addCheckItem = event.target.closest("[data-add-check-item]");
    if (addCheckItem) {
      const card = addCheckItem.closest(".memo-note");
      const item = memoState.items.find((memo) => memo.id === card?.dataset.memoId);
      if (!item) return;
      syncMemoFromCard(card);
      item.rows.push({ text: "新的清单项", checked: false });
      saveMemoItems();
      renderMemoList();
    }
    const removeCheckItem = event.target.closest("[data-remove-check-item]");
    if (removeCheckItem) {
      const card = removeCheckItem.closest(".memo-note");
      const item = memoState.items.find((memo) => memo.id === card?.dataset.memoId);
      if (!item) return;
      const index = Number(removeCheckItem.dataset.removeCheckItem);
      syncMemoFromCard(card);
      item.rows.splice(index, 1);
      saveMemoItems();
      renderMemoList();
    }
    const addPacking = event.target.closest("[data-add-packing-item]");
    if (addPacking) {
      syncPackingFromDom();
      addPackingItem(addPacking.closest("[data-packing-group]")?.dataset.packingGroup);
    }
    const removePackingItem = event.target.closest("[data-remove-packing-item]");
    if (removePackingItem) {
      const groupId = removePackingItem.closest("[data-packing-group]")?.dataset.packingGroup;
      const itemId = removePackingItem.closest("[data-packing-item]")?.dataset.packingItem;
      syncPackingFromDom();
      const group = packingState.groups.find((item) => item.id === groupId);
      if (group) group.items = group.items.filter((item) => item.id !== itemId);
      savePackingState();
      renderPackingList();
    }
    const removePackingGroup = event.target.closest("[data-remove-packing-group]");
    if (removePackingGroup) {
      const groupId = removePackingGroup.closest("[data-packing-group]")?.dataset.packingGroup;
      packingState.groups = packingState.groups.filter((item) => item.id !== groupId);
      savePackingState();
      renderPackingList();
    }
    if (event.target.closest("[data-add-packing-group]")) addPackingGroup();
  });
  ["[data-plan-destination]", "[data-plan-days]", "[data-plan-start]"].forEach((selector) => {
    document.querySelector(selector)?.addEventListener("change", renderPlannerTable);
  });
  document.querySelector("[data-ledger-list]").innerHTML = ledgerRow("交通", "") + ledgerRow("餐饮", "");
  memoState.items = loadMemoItems();
  packingState.groups = loadPackingState();
  renderMemoList();
  renderPackingList();
  renderPlannerTable();
}

document.addEventListener("DOMContentLoaded", async () => {
  installFlightNavigation();
  await loadBootstrapData();
  loadUserContentState();
  const page = document.body.dataset.page;
  if (page === "home") initHome();
  if (page === "destination") initDestination();
  if (page === "guides") initGuides();
  if (page === "songs") initSongs();
  if (page === "postcard") initPostcard();
  if (page === "ai") initAi();
  if (page === "planner") initPlanner();
});
