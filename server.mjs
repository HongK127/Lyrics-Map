import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const localConfig = loadLocalConfig();
const port = Number(process.env.PORT || 4174);
const aiProvider = (process.env.AI_PROVIDER || localConfig.ai?.provider || "deepseek").toLowerCase();

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function loadLocalConfig() {
  try {
    return JSON.parse(readFileSync(join(root, "config.local.json"), "utf8"));
  } catch {
    return {};
  }
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

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 80_000) throw new Error("Request body too large");
  }
  return body ? JSON.parse(body) : {};
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

  if (!fullPath.startsWith(root)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  try {
    const data = await readFile(fullPath);
    res.writeHead(200, { "Content-Type": mime[extname(fullPath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname === "/api/ai/chat") {
      await handleAiChat(req, res);
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(port, () => {
  console.log(`Cheer travel atlas running at http://localhost:${port}`);
});
