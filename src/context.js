/**
 * Local context bands (mock). No fortune fields.
 *
 * weather_band — clothing only: hot | cool | rain
 * opener_weather — greeting atmosphere: clear | cloudy | rain | extreme
 * time_band — 朝早／晏晝／夜晚／深夜: morning | afternoon | evening | late_night
 *
 * opener_weather is resolved on its own. It is not copied from weather_band.
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
export const OPENER_WEATHERS = ["clear", "cloudy", "rain", "extreme"];
export const TIME_BANDS = ["morning", "afternoon", "evening", "late_night"];
export const DEFAULT_TIME_ZONE = "Asia/Hong_Kong";

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

export function resolveOpenerWeather({ city = "" } = {}) {
  const label = String(city ?? "");
  if (/(extreme|storm|typhoon|heatwave|颱|飓|颶|酷熱)/i.test(label)) {
    return "extreme";
  }
  if (/(rain|雨|london|seattle)/i.test(label)) return "rain";
  if (/(cloud|overcast|陰|阴)/i.test(label)) return "cloudy";
  if (/(clear|sunny|晴)/i.test(label)) return "clear";
  return "clear";
}

export function hourInTimeZone(date, timeZone = DEFAULT_TIME_ZONE) {
  const zone = timeZone || DEFAULT_TIME_ZONE;
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "numeric",
      hourCycle: "h23",
    });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: DEFAULT_TIME_ZONE,
      hour: "numeric",
      hourCycle: "h23",
    });
  }
  const part = fmt.formatToParts(date).find((p) => p.type === "hour");
  let hour = Number(part?.value);
  if (!Number.isInteger(hour)) return 12;
  if (hour === 24) hour = 0;
  return hour;
}

/** 05–11 朝早, 12–17 晏晝, 18–22 夜晚, 23–04 深夜. */
export function resolveTimeBand(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const hour = hourInTimeZone(date, timeZone);
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 23) return "evening";
  return "late_night";
}

export function buildLocalContext(query = {}, locale = "zh-HK", options = {}) {
  const weather_band = resolveWeatherBand(query);
  const opener_weather = resolveOpenerWeather(query);
  const now = options.now instanceof Date ? options.now : new Date();
  const time_band = resolveTimeBand(now, options.timeZone ?? DEFAULT_TIME_ZONE);
  const pack = SUMMARIES[locale] ?? SUMMARIES["zh-HK"];
  return {
    time_band,
    opener_weather,
    weather_band,
    summary: pack[weather_band],
    updated_at: now.toISOString(),
  };
}
