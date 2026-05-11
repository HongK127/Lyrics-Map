import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../data.js", import.meta.url), "utf8");

const forbidden = ["coordinateOffsets", "latOffset", "lngOffset", "Explicit prototype display coordinate"];
const forbiddenHits = forbidden.filter((token) => source.includes(token));
if (forbiddenHits.length) {
  console.error(`Coordinate check failed: generated offset logic remains: ${forbiddenHits.join(", ")}`);
  process.exit(1);
}

const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "data.js" });

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
if (!appSource.includes("AMap.Geocoder") || !appSource.includes("AMap.PlaceSearch") || !appSource.includes("resolveGuideRowPosition")) {
  console.error("Coordinate check failed: local map no longer resolves official guide points through AMap PlaceSearch/Geocoder.");
  process.exit(1);
}

const sections = ["eat", "stay", "move", "shop"];
const invalid = [];
const missingSource = [];
let total = 0;

for (const destination of sandbox.window.CHEER_TRAVEL_DATA.destinations || []) {
  for (const section of sections) {
    for (const row of destination.recommendations?.[section] || []) {
      total += 1;
      const lat = row.lat === null || row.lat === undefined || row.lat === "" ? null : Number(row.lat);
      const lng = row.lng === null || row.lng === undefined || row.lng === "" ? null : Number(row.lng);
      const hasLatLng = lat !== null && lng !== null;
      if (!row.source?.sourceUrl) {
        missingSource.push(`${destination.id}.${section}.${row.name}`);
      }
      if (hasLatLng && (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180)) {
        invalid.push(`${destination.id}.${section}.${row.name} (${lat}, ${lng})`);
      }
    }
  }
}

if (missingSource.length || invalid.length) {
  if (missingSource.length) console.error(`Missing coordinate source URL (${missingSource.length}):\n${missingSource.join("\n")}`);
  if (invalid.length) console.error(`Invalid coordinates (${invalid.length}):\n${invalid.join("\n")}`);
  process.exit(1);
}

console.log(`Coordinate check passed: ${total} official recommendation points use source-backed runtime geocoding.`);
