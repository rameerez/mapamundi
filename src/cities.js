// The built-in city registry: type "Lagos", get a marker — no coordinate
// hunting. ~160 cities chosen for world coverage (every continent, the
// places people actually mark on hero maps), keyed by lowercase name.
// Coordinates are city-center approximations to one decimal (~11 km) —
// far finer than any sane dot grid, since markers snap to the nearest
// land dot anyway.
//
// Not in the registry? Pass { name: "…", lat: …, lon: … } instead — custom
// entries and registry names mix freely in the same `cities` array.

export const CITIES = {
  // Europe
  "london": [51.5, -0.1], "paris": [48.9, 2.4], "berlin": [52.5, 13.4],
  "madrid": [40.4, -3.7], "barcelona": [41.4, 2.2], "rome": [41.9, 12.5],
  "milan": [45.5, 9.2], "amsterdam": [52.4, 4.9], "brussels": [50.8, 4.4],
  "vienna": [48.2, 16.4], "zurich": [47.4, 8.5], "geneva": [46.2, 6.1],
  "lisbon": [38.7, -9.1], "dublin": [53.3, -6.3], "copenhagen": [55.7, 12.6],
  "stockholm": [59.3, 18.1], "oslo": [59.9, 10.8], "helsinki": [60.2, 24.9],
  "warsaw": [52.2, 21.0], "prague": [50.1, 14.4], "budapest": [47.5, 19.0],
  "athens": [38.0, 23.7], "istanbul": [41.0, 28.9], "kyiv": [50.5, 30.5],
  "bucharest": [44.4, 26.1], "belgrade": [44.8, 20.5], "munich": [48.1, 11.6],
  "hamburg": [53.6, 10.0], "frankfurt": [50.1, 8.7], "edinburgh": [55.9, -3.2],
  "manchester": [53.5, -2.2], "porto": [41.1, -8.6], "valencia": [39.5, -0.4],
  "seville": [37.4, -6.0], "luxembourg": [49.6, 6.1], "reykjavik": [64.1, -21.9],

  // North America
  "new york": [40.7, -74.0], "los angeles": [34.1, -118.2],
  "san francisco": [37.8, -122.4], "chicago": [41.9, -87.6],
  "miami": [25.8, -80.2], "houston": [29.8, -95.4], "dallas": [32.8, -96.8],
  "seattle": [47.6, -122.3], "boston": [42.4, -71.1], "austin": [30.3, -97.7],
  "denver": [39.7, -105.0], "atlanta": [33.7, -84.4], "washington": [38.9, -77.0],
  "philadelphia": [39.9, -75.2], "phoenix": [33.4, -112.1], "las vegas": [36.2, -115.1],
  "toronto": [43.7, -79.4], "vancouver": [49.3, -123.1], "montreal": [45.5, -73.6],
  "calgary": [51.0, -114.1], "mexico city": [19.4, -99.1], "guadalajara": [20.7, -103.3],
  "monterrey": [25.7, -100.3], "havana": [23.1, -82.4], "panama city": [9.0, -79.5],
  "san jose": [37.3, -121.9], "guatemala city": [14.6, -90.5],

  // South America
  "sao paulo": [-23.6, -46.6], "rio de janeiro": [-22.9, -43.2],
  "buenos aires": [-34.6, -58.4], "santiago": [-33.5, -70.7],
  "lima": [-12.0, -77.0], "bogota": [4.7, -74.1], "medellin": [6.2, -75.6],
  "quito": [-0.2, -78.5], "caracas": [10.5, -66.9], "montevideo": [-34.9, -56.2],
  "brasilia": [-15.8, -47.9], "cordoba": [-31.4, -64.2], "la paz": [-16.5, -68.1],

  // Africa
  "lagos": [6.5, 3.4], "cairo": [30.0, 31.2], "nairobi": [-1.3, 36.8],
  "johannesburg": [-26.2, 28.0], "cape town": [-33.9, 18.4],
  "accra": [5.6, -0.2], "abidjan": [5.3, -4.0], "dakar": [14.7, -17.5],
  "casablanca": [33.6, -7.6], "algiers": [36.8, 3.1], "tunis": [36.8, 10.2],
  "addis ababa": [9.0, 38.7], "dar es salaam": [-6.8, 39.3],
  "kampala": [0.3, 32.6], "kinshasa": [-4.3, 15.3], "luanda": [-8.8, 13.2],
  "kigali": [-1.9, 30.1], "tripoli": [32.9, 13.2], "khartoum": [15.6, 32.5],
  "abuja": [9.1, 7.4], "marrakesh": [31.6, -8.0],

  // Middle East & Central Asia
  "dubai": [25.2, 55.3], "abu dhabi": [24.5, 54.4], "riyadh": [24.7, 46.7],
  "jeddah": [21.5, 39.2], "doha": [25.3, 51.5], "tel aviv": [32.1, 34.8],
  "jerusalem": [31.8, 35.2], "amman": [31.9, 36.0], "beirut": [33.9, 35.5],
  "tehran": [35.7, 51.4], "baghdad": [33.3, 44.4], "kuwait city": [29.4, 48.0],
  "muscat": [23.6, 58.6], "tashkent": [41.3, 69.3], "almaty": [43.2, 76.9],
  "baku": [40.4, 49.9], "tbilisi": [41.7, 44.8], "yerevan": [40.2, 44.5],

  // Asia
  "tokyo": [35.7, 139.7], "osaka": [34.7, 135.5], "kyoto": [35.0, 135.8],
  "seoul": [37.6, 127.0], "busan": [35.2, 129.1], "beijing": [39.9, 116.4],
  "shanghai": [31.2, 121.5], "shenzhen": [22.5, 114.1], "guangzhou": [23.1, 113.3],
  "chengdu": [30.7, 104.1], "hong kong": [22.3, 114.2], "taipei": [25.0, 121.6],
  "singapore": [1.4, 103.8], "kuala lumpur": [3.2, 101.7], "jakarta": [-6.2, 106.8],
  "bangkok": [13.8, 100.5], "ho chi minh city": [10.8, 106.7], "hanoi": [21.0, 105.9],
  "manila": [14.6, 121.0], "mumbai": [19.1, 72.9], "delhi": [28.6, 77.2],
  "bangalore": [13.0, 77.6], "hyderabad": [17.4, 78.5], "chennai": [13.1, 80.3],
  "kolkata": [22.6, 88.4], "karachi": [24.9, 67.0], "lahore": [31.5, 74.3],
  "dhaka": [23.8, 90.4], "colombo": [6.9, 79.9], "kathmandu": [27.7, 85.3],
  "yangon": [16.8, 96.2], "phnom penh": [11.6, 104.9], "ulaanbaatar": [47.9, 106.9],

  // Oceania
  "sydney": [-33.9, 151.2], "melbourne": [-37.8, 145.0], "brisbane": [-27.5, 153.0],
  "perth": [-32.0, 115.9], "adelaide": [-34.9, 138.6], "auckland": [-36.8, 174.8],
  "wellington": [-41.3, 174.8], "christchurch": [-43.5, 172.6],

  // Russia
  "moscow": [55.8, 37.6], "saint petersburg": [59.9, 30.3],
  "novosibirsk": [55.0, 82.9], "vladivostok": [43.1, 131.9]
};

// Resolve one entry from the `cities` option: a registry name (string,
// case-insensitive) or a { name, lat, lon, … } object. Returns a normalized
// object or null for unknown names (the renderer warns, never throws — a
// typo'd city must not take down a hero section).
export function resolveCity(entry) {
  if (typeof entry === "string") {
    const coords = CITIES[entry.trim().toLowerCase()];
    return coords ? { name: entry.trim(), lat: coords[0], lon: coords[1] } : null;
  }
  if (entry && typeof entry.lat === "number" && typeof entry.lon === "number") {
    return { name: entry.name ?? "", ...entry };
  }
  return null;
}
