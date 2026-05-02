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

function destinationUrl(item) {
  return `./destination.html?id=${encodeURIComponent(item.id)}`;
}

function setImage(img, src, alt) {
  if (!img) return;
  img.src = src;
  img.alt = alt || "";
  img.onerror = () => {
    img.removeAttribute("src");
    img.classList.add("image-fallback");
  };
}

function sourceLink(src) {
  if (!src) return "";
  const label = src.pending ? `${src.sourceName} · 待核验` : src.sourceName;
  return `<a href="${src.sourceUrl}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
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
  loader.innerHTML = '<div class="flight-path"><span class="plane">✈</span></div>';
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
    }, 560);
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
}

function continentById(id) {
  return continents.find((item) => item.id === id) || continents[0];
}

function luggageMarkerContent(item) {
  return `<div class="atlas-marker"><span>${escapeHtml(item.name)}</span></div>`;
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
      offset: new AMapRuntime.Pixel(-46, -17),
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

function renderRecommendations(item) {
  const board = document.querySelector("[data-recommendation-board]");
  if (!board) return;
  const order = ["eat", "stay", "move", "shop"];
  const titles = { eat: "吃", stay: "住", move: "行", shop: "购物" };
  board.innerHTML = order.map((kind) => `
    <section class="guide-card ${kind}">
      <h3>${titles[kind]}</h3>
      ${item.recommendations[kind].map((row) => `
        <article>
          <strong>${escapeHtml(row.name)}</strong>
          <p>${escapeHtml(row.description)}</p>
          <small>${escapeHtml(row.verification)}</small>
          <a class="source-chip" href="${row.source.sourceUrl}" target="_blank" rel="noreferrer">${escapeHtml(row.source.sourceName)}</a>
        </article>
      `).join("")}
    </section>
  `).join("");
}

function localPinContent(kind) {
  const label = { eat: "吃", stay: "住", move: "行", shop: "购" }[kind] || "点";
  return `<div class="local-pin ${kind}"><span>${label}</span></div>`;
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

  const map = new AMap.Map(mapEl, {
    viewMode: "2D",
    zoom,
    center: mapPosition(item),
    resizeEnable: true,
    mapStyle: amapConfig.style || "amap://styles/macaron",
  });
  map.addControl(new AMap.Scale());
  map.addControl(new AMap.ToolBar({ position: "RB" }));
  const infoWindow = new AMap.InfoWindow({ offset: new AMap.Pixel(0, -20) });

  item.mapPins.forEach((pin) => {
    const marker = new AMap.Marker({
      position: [pin.lng, pin.lat],
      content: localPinContent(pin.kind),
      offset: new AMap.Pixel(-15, -15),
    });
    marker.on("click", () => {
      infoWindow.setContent(`<strong>${escapeHtml(pin.name)}</strong><br><a href="${pin.sourceUrl}" target="_blank" rel="noreferrer">打开来源</a>`);
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
  document.querySelector("[data-route-list]").innerHTML = item.route.map((step) => `<li>${escapeHtml(step)}</li>`).join("");
  document.querySelector("[data-source-list]").innerHTML = item.sources.map((src) => `<span class="source-chip">${sourceLink(src)}</span>`).join("");
  renderRecommendations(item);
  renderLocalMap(item);
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
              </div>
            </a>
          `).join("")}
        </div>
      </section>
    `;
  }).join("");
}

function initSongs() {
  const grid = document.querySelector("[data-song-grid]");
  if (!grid) return;
  grid.innerHTML = songs.map((song) => `
    <article class="song-card">
      <img src="${song.localCover || song.cover}" alt="${escapeHtml(song.album)} 封面">
      <div>
        <p class="eyebrow">${escapeHtml(song.artist)}</p>
        <h2>${escapeHtml(song.title)}</h2>
        <p class="album-name">${escapeHtml(song.album)}</p>
        <blockquote>${escapeHtml(song.lyric)}</blockquote>
        <p>${escapeHtml(song.notes)}</p>
        <div class="tag-row">${song.places.map((place) => `<span>${escapeHtml(place)}</span>`).join("")}</div>
        <div class="song-sources">
          <a href="${song.factSource.sourceUrl}" target="_blank" rel="noreferrer">事实来源</a>
          <a href="${song.coverSource.sourceUrl}" target="_blank" rel="noreferrer">${song.coverSource.pending ? "封面待核验" : "封面来源"}</a>
        </div>
      </div>
    </article>
  `).join("");
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
      const modeText = payload.mode === "playlist" ? "个性化旅行歌单" : "旅行建议";
      const prompt = `你是“陈绮贞歌词地图”的旅行助手。请根据以下信息生成${modeText}。
目的地：${payload.destination}
天数：${payload.days}
预算：${payload.budget}
喜欢的类型 / 风格：${payload.style}

要求：
1. 用中文输出，语气温柔、文艺、可执行。
2. 如果生成旅行建议，请按上午 / 下午 / 晚上 / 注意事项整理。
3. 如果生成旅行歌单，请给 12 首以内，并说明每首歌适合的旅行场景。
4. 如模型具备联网能力，请先核验当前营业、交通、天气或活动信息，并标注“需出发前再确认”的项目。
5. 可参考陈绮贞歌词地图的气质：地图、书信、明信片、慢游、城市夜色、海边、火车、公路。`;

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

document.addEventListener("DOMContentLoaded", () => {
  installFlightNavigation();
  const page = document.body.dataset.page;
  if (page === "home") initHome();
  if (page === "destination") initDestination();
  if (page === "guides") initGuides();
  if (page === "songs") initSongs();
  if (page === "postcard") initPostcard();
  if (page === "ai") initAi();
});
