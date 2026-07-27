import { getAmapRuntimeConfig, loadAmap } from "./amapLoader.js";

function pluginReady(AMap) {
  return new Promise((resolve, reject) => {
    try {
      AMap.plugin("AMap.Geocoder", resolve);
    } catch {
      reject(new Error("地址定位服务暂不可用"));
    }
  });
}

function numericLocation(value) {
  const lng = Number(typeof value?.getLng === "function" ? value.getLng() : value?.lng);
  const lat = Number(typeof value?.getLat === "function" ? value.getLat() : value?.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng, lat };
}

function geocodeAddress(AMap, { address, city, label }) {
  return new Promise((resolve, reject) => {
    let geocoder;
    try {
      geocoder = new AMap.Geocoder({ city: city || "全国" });
    } catch {
      reject(new Error("地址定位服务暂不可用"));
      return;
    }
    geocoder.getLocation(address, (status, result) => {
      const location = numericLocation(result?.geocodes?.[0]?.location);
      if (status !== "complete" || result?.info !== "OK" || !location) {
        reject(new Error(`无法定位${label}，请检查地址和城市`));
        return;
      }
      resolve(location);
    });
  });
}

export async function geocodeVisitItineraryPayload(payload, {
  config = getAmapRuntimeConfig(),
  loadAmapImpl = loadAmap,
} = {}) {
  if (!config?.key) return payload;

  let AMap;
  try {
    AMap = await loadAmapImpl(config);
    await pluginReady(AMap);
  } catch {
    throw new Error("地址定位服务暂不可用，请稍后重试");
  }

  const [departureLocation, ...stopLocations] = await Promise.all([
    geocodeAddress(AMap, {
      address: payload.departureAddress,
      city: payload.departureCity,
      label: "出发地址",
    }),
    ...payload.stops.map((stop) => geocodeAddress(AMap, {
      address: stop.address,
      city: stop.city,
      label: "客户地址",
    })),
  ]);

  return {
    ...payload,
    departureLocation,
    stops: payload.stops.map((stop, index) => ({
      ...stop,
      location: stopLocations[index],
    })),
  };
}
