/**
 * W2.5 local weather context (mock). Clothing bands only — no fortune fields.
 */

const SUMMARIES = {
  "zh-HK": {
    hot: "今日偏熱，着透氣薄衫就得。",
    cool: "今日偏涼，加件薄外套穩陣啲。",
    rain: "今日會落雨，出街帶遮。",
  },
  "zh-CN": {
    hot: "今天偏热，穿透气薄衫就行。",
    cool: "今天偏凉，加件薄外套更稳。",
    rain: "今天会下雨，出门带伞。",
  },
  en: {
    hot: "It's hot — light, breathable clothes.",
    cool: "It's cool — a light layer is enough.",
    rain: "Rain today — bring a cover.",
  },
};

export const WEATHER_BANDS = ["hot", "cool", "rain"];

export function parseCoord(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function resolveWeatherBand({ lat = null, lon = null, city = "" } = {}) {
  const label = String(city ?? "").toLowerCase();
  if (/(rain|雨|london|seattle)/i.test(label)) return "rain";
  if (/(cool|cold|涼|凉|冷|seoul|oslo)/i.test(label)) return "cool";
  if (lat != null && Number.isFinite(lat) && lat >= 40) return "cool";
  if (lat != null && Number.isFinite(lat) && lon != null && Number.isFinite(lon)) {
    // Tropical / subtropical default (HK-ish) stays hot unless city matched rain.
    if (Math.abs(lat) < 23.5) return "hot";
  }
  return "hot";
}

export function buildLocalContext(query = {}, locale = "zh-HK") {
  const band = resolveWeatherBand(query);
  const pack = SUMMARIES[locale] ?? SUMMARIES["zh-HK"];
  return {
    weather_band: band,
    summary: pack[band],
    updated_at: new Date().toISOString(),
  };
}
