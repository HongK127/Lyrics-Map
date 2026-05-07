const { destinations, songs, continents } = window.CHEER_TRAVEL_DATA;
const byId = new Map(destinations.map((item) => [item.id, item]));
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
let homeMap;
let homeMarkers = [];
let AMapRuntime;
let AMapScriptPromise;

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
  const type = item?.type === "song" ? "song" : "destination";
  if (type === "song") {
    return {
      id: item?.id || userContentId("contribution"),
      type,
      title: String(item?.title || "").trim(),
      artist: String(item?.artist || "").trim(),
      album: String(item?.album || "").trim(),
      places: Array.isArray(item?.places) ? item.places.map((place) => String(place || "").trim()).filter(Boolean) : [],
      lyric: String(item?.lyric || "").trim(),
      sourceUrl: safeExternalUrl(item?.sourceUrl),
      status: item?.status || "待收录",
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
      plugin: "AMap.Scale,AMap.ToolBar",
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

function visibleDestinations() {
  return destinations.filter((item) => {
    const continentOk =
      activeContinent === "all" ||
      item.continent === activeContinent ||
      (activeContinent === "意象" && item.isConceptPlace);
    const haystack = `${item.displayName} ${item.continent} ${item.songs.join(" ")} ${item.lyricLines.join(" ")}`.toLowerCase();
    return continentOk && haystack.includes(activeQuery);
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
  setImage(document.querySelector("[data-postcard-image]"), item.postcardImage, `${item.displayName} 明信片`);
  document.querySelector("[data-postcard-title]").textContent = item.displayName;
  document.querySelector("[data-postcard-intro]").textContent = item.intro;
  document.querySelector("[data-postcard-lyric]").textContent = item.lyricLines[0] || "";
  document.querySelector("[data-postcard-link]").href = destinationUrl(item);
  document.querySelector("[data-postcard-source]").innerHTML = `图片：${sourceLink(item.imageCredit)}`;
  const sceneSlot = document.querySelector("[data-postcard-movie]");
  if (sceneSlot) sceneSlot.innerHTML = movieSceneCard(item);
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
  list.innerHTML = visibleDestinations().map((item) => `
    <button type="button" data-home-place="${item.id}">
      <img src="${item.postcardImage}" alt="">
      <span>${escapeHtml(item.name)}</span>
    </button>
  `).join("");
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
    return `<button type="button" class="text-action" data-hide-guide-item="${escapeHtml(entry.id)}">隐藏到我的攻略</button>`;
  }
  return `<button type="button" class="text-action danger" data-delete-user-guide="${escapeHtml(entry.id)}" data-user-guide-source="${entry.origin === "contribution" ? "contribution" : "custom"}">删除</button>`;
}

function officialRecommendationRows(item, kind) {
  return (item.recommendations[kind] || []).map((row, index) => ({
    ...row,
    id: officialGuideId(item.id, kind, index),
    origin: "official",
    section: kind,
  }));
}

function customRecommendationRows(item, kind) {
  return userGuideEntries(item, kind).map((entry) => ({
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
  }));
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
          ${row.origin === "contribution" ? contributionBadge() : row.origin === "custom" ? contributionBadge("用户添加") : ""}
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
  const books = [...officialBooks.filter((book) => !isHiddenGuide(book.id)), ...userBooks];
  list.innerHTML = books.length
    ? books.map((book) => `
      <article class="reading-card ${book.origin === "official" ? "" : "user-guide-entry"}">
        <span class="reading-mark">${book.origin === "contribution" ? "投稿" : book.origin === "custom" ? "我的" : "READ"}</span>
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
  list.innerHTML = [...officialRoutes.filter((step) => !isHiddenGuide(step.id)), ...userRoutes].map((step) => {
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
  return [...officialPins, ...userPins];
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

function rerenderDestinationContent(item) {
  renderMovieScene(item);
  renderRecommendations(item);
  renderReadingRecommendations(item);
  renderRouteList(item);
  renderHiddenGuides(item);
  renderLocalMap(item);
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

  document.querySelector("[data-destination-contribution-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const current = getCurrentDestination();
    const entry = {
      ...guideEntryFromForm(current, "contribution"),
      id: userContentId("contribution"),
      type: "destination",
      status: "待收录",
    };
    contributionState.items.unshift(normalizeContributionItem(entry));
    saveContributions();
    resetGuideForm("contribution");
    setInlineStatus("[data-destination-contribution-status]", "已提交，正在以待收录状态预览");
    rerenderDestinationContent(current);
  });

  document.addEventListener("click", (event) => {
    const preset = event.target.closest("[data-preset-guide-section]");
    if (preset) {
      presetGuideSection(preset.dataset.presetGuideSection);
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
  const groups = [...new Set(destinations.map((item) => item.continent))];
  list.innerHTML = groups.map((continent) => {
    const rows = destinations.filter((item) => item.continent === continent);
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
  const sourceUrl = origin === "official" ? song.factSource?.sourceUrl : song.sourceUrl;
  const sourceLabel = origin === "official" ? "事实来源" : "用户投稿来源";
  return `
    <article class="song-card ${origin === "official" ? "" : "user-song-card"}">
      <img src="${escapeHtml(song.localCover || song.cover || "./assets/journal/stamp-sheet.jpg")}" alt="${escapeHtml(song.album || "歌曲投稿")} 封面">
      <div>
        ${origin === "official" ? "" : contributionBadge()}
        <p class="eyebrow">${escapeHtml(song.artist || "待补充歌手")}</p>
        <h2>${escapeHtml(song.title || "未命名歌曲")}</h2>
        <p class="album-name">${escapeHtml(song.album || "待补充专辑 / 来源")}</p>
        <blockquote>${escapeHtml(song.lyric || "暂未填写歌词片段。")}</blockquote>
        <p>${escapeHtml(song.notes || (origin === "official" ? "" : "这条歌曲投稿保存在当前浏览器，公开收录前仍需核验。"))}</p>
        <div class="tag-row">${(song.places || []).map((place) => `<span>${escapeHtml(place)}</span>`).join("")}</div>
        <div class="song-sources">
          ${sourceChip(sourceUrl, sourceLabel)}
          ${origin === "official" ? sourceChip(song.coverSource?.sourceUrl, song.coverSource?.pending ? "封面待核验" : "封面来源") : `<button type="button" class="text-action danger" data-delete-song-contribution="${escapeHtml(song.id)}">删除投稿</button>`}
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
  grid.innerHTML = [
    ...songContributions.map((song) => renderSongCard(song, "contribution")),
    ...songs.map((song) => renderSongCard(song, "official")),
  ].join("");
}

function initSongs() {
  renderSongList();
  const form = document.querySelector("[data-song-contribution-form]");
  if (form && !form.dataset.bound) {
    form.dataset.bound = "true";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const entry = normalizeContributionItem({
        id: userContentId("contribution"),
        type: "song",
        title: document.querySelector("[data-song-title]")?.value || "",
        artist: document.querySelector("[data-song-artist]")?.value || "",
        album: document.querySelector("[data-song-album]")?.value || "",
        places: parsePlaces(document.querySelector("[data-song-places]")?.value || ""),
        lyric: document.querySelector("[data-song-lyric]")?.value || "",
        sourceUrl: document.querySelector("[data-song-source-url]")?.value || "",
        status: "待收录",
        createdAt: Date.now(),
      });
      contributionState.items.unshift(entry);
      saveContributions();
      form.reset();
      setInlineStatus("[data-song-contribution-status]", "已提交，正在以待收录状态预览");
      renderSongList();
    });
  }

  document.addEventListener("click", (event) => {
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

function makeImagePdf(jpegBytes, imageWidth, imageHeight) {
  const pageWidth = 720;
  const pageHeight = Math.round((imageHeight / imageWidth) * pageWidth);
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
  addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  addObject(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = offset;
  addString(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
  addBytes(jpegBytes);
  addString("\nendstream\nendobj\n");
  const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ`;
  addObject(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);

  const xrefOffset = offset;
  addString("xref\n0 6\n0000000000 65535 f \n");
  for (let i = 1; i <= 5; i += 1) addString(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  addString(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return new Blob(chunks, { type: "application/pdf" });
}

async function downloadPostcardPdf() {
  const canvas = await renderPostcardCanvas();
  const jpegBytes = await canvasJpegBytes(canvas);
  downloadBlob(makeImagePdf(jpegBytes, canvas.width, canvas.height), "travel-postcard.pdf");
}

function initPostcard() {
  const select = document.querySelector("[data-postcard-destination]");
  const image = document.querySelector("[data-custom-image]");
  const title = document.querySelector("[data-custom-title]");
  const lyric = document.querySelector("[data-custom-lyric]");
  const text = document.querySelector("[data-custom-text]");
  const textarea = document.querySelector("[data-postcard-text]");
  if (!select || !image) return;

  select.innerHTML = destinations.map((item) => `<option value="${item.id}">${escapeHtml(item.displayName)}</option>`).join("");

  function render() {
    const item = byId.get(select.value) || destinations[0];
    if (!image.dataset.customSrc) setImage(image, item.postcardImage, item.displayName);
    title.textContent = item.displayName;
    lyric.textContent = item.lyricLines[0] || "";
    text.textContent = textarea.value;
  }

  select.addEventListener("change", () => {
    image.dataset.customSrc = "";
    render();
  });
  textarea.addEventListener("input", render);
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
  });
}

function defaultMemoItems() {
  return [
    createMemoFromUrl("https://www.xiaohongshu.com/search_result?keyword=%E6%97%85%E8%A1%8C%20%E6%89%8B%E5%B8%90"),
    createMemo("photo", {
      title: "胶片拍照",
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
        <span class="memo-link-thumb">${escapeHtml(memoPlatformIcons[platform] || "↗")}</span>
        <span>
          <strong>${escapeHtml(platform)}</strong>
          <small>${escapeHtml(memoHost(href))}</small>
          <em>${escapeHtml(href)}</em>
        </span>
      </a>
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

function exportPlannerCsv() {
  const cellText = (cell) => {
    const formValues = [...cell.querySelectorAll("input, textarea")]
      .map((field) => {
        if (field.type === "checkbox") return field.checked ? field.closest("label")?.innerText.trim() : "";
        return field.value.trim();
      })
      .filter(Boolean)
      .join(" / ");
    return [cell.innerText.trim(), formValues].filter(Boolean).join(" / ");
  };
  const rows = [...document.querySelectorAll(".itinerary-table tr")].map((tr) =>
    [...tr.children].map((cell) => `"${cellText(cell).replaceAll('"', '""')}"`).join(",")
  );
  if (!rows.length) return;
  const blob = new Blob([`\uFEFF${rows.join("\n")}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "travel-itinerary.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function initPlanner() {
  const select = document.querySelector("[data-plan-destination]");
  if (!select) return;
  select.innerHTML = destinations.map((item) => `<option value="${item.id}">${escapeHtml(item.displayName)}</option>`).join("");
  document.querySelector("[data-plan-generate]")?.addEventListener("click", renderPlannerTable);
  document.querySelector("[data-plan-export]")?.addEventListener("click", exportPlannerCsv);
  document.querySelector("[data-plan-print]")?.addEventListener("click", () => window.print());
  document.querySelector("[data-add-ledger]")?.addEventListener("click", () => {
    document.querySelector("[data-ledger-list]")?.insertAdjacentHTML("beforeend", ledgerRow());
  });
  document.querySelector("[data-add-memo]")?.addEventListener("click", () => addMemoItem(createMemo("text")));
  document.querySelectorAll("[data-add-memo-type]").forEach((button) => {
    button.addEventListener("click", () => addMemoItem(createMemo(button.dataset.addMemoType)));
  });
  const memoUrlInput = document.querySelector("[data-memo-url]");
  const addLinkMemo = () => {
    const item = createMemoFromUrl(memoUrlInput?.value || "");
    if (!item) return;
    addMemoItem(item);
    memoUrlInput.value = "";
  };
  document.querySelector("[data-add-link-memo]")?.addEventListener("click", addLinkMemo);
  memoUrlInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") addLinkMemo();
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
    const photoUpload = event.target.closest("[data-memo-photo-upload]");
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

document.addEventListener("DOMContentLoaded", () => {
  installFlightNavigation();
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
