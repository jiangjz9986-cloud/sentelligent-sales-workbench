import { MapPin } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { getAmapRuntimeConfig, loadAmap } from "./amapLoader.js";
import { orderedVisitStops } from "./visitItineraryModel.js";

function markerElement(label, kind) {
  const element = document.createElement("span");
  element.className = `itinerary-map-marker ${kind}`;
  element.textContent = label;
  return element;
}

export function AmapRouteMap({ itinerary }) {
  const containerRef = useRef(null);
  const [status, setStatus] = useState("loading");

  useEffect(() => {
    const container = containerRef.current;
    const plan = itinerary?.plan;
    const routePath = Array.isArray(plan?.route?.polyline) ? plan.route.polyline : [];
    const departure = plan?.departure?.location;
    const stops = orderedVisitStops(itinerary);
    const config = getAmapRuntimeConfig();
    if (!container || !config.key || !departure || stops.length === 0) {
      setStatus("unavailable");
      return undefined;
    }

    let cancelled = false;
    let map = null;
    setStatus("loading");
    loadAmap(config)
      .then((AMap) => {
        if (cancelled) return;
        map = new AMap.Map(container, {
          viewMode: "2D",
          resizeEnable: true,
          zoom: 8,
          center: [departure.lng, departure.lat],
        });
        const overlays = [];
        if (routePath.length > 1) {
          overlays.push(new AMap.Polyline({
            path: routePath.map((point) => [point.lng, point.lat]),
            strokeColor: "#007aff",
            strokeWeight: 6,
            strokeOpacity: 0.88,
            lineJoin: "round",
            lineCap: "round",
            showDir: true,
          }));
        }
        overlays.push(new AMap.Marker({
          position: [departure.lng, departure.lat],
          content: markerElement("起", "origin"),
          anchor: "center",
          title: itinerary.plan.departure.formattedAddress || itinerary.request.departureAddress,
        }));
        stops.forEach((stop, index) => {
          overlays.push(new AMap.Marker({
            position: [stop.location.lng, stop.location.lat],
            content: markerElement(String(index + 1), "stop"),
            anchor: "center",
            title: stop.customerName || stop.formattedAddress,
          }));
        });
        map.add(overlays);
        map.setFitView(overlays, false, [44, 44, 44, 44], 12);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    return () => {
      cancelled = true;
      if (map) map.destroy();
    };
  }, [itinerary]);

  return (
    <div className="itinerary-map-shell" aria-label="拜访路线地图">
      <div ref={containerRef} className="itinerary-map-canvas" data-map-status={status} />
      {status !== "ready" ? (
        <div className="itinerary-map-fallback" data-testid="itinerary-map-fallback" role="status">
          <MapPin size={22} />
          <span>{status === "loading" ? "地图加载中" : "路线地图暂不可用"}</span>
        </div>
      ) : null}
    </div>
  );
}
