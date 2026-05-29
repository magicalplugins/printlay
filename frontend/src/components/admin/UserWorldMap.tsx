import { useMemo, useState, useCallback } from "react";
import {
  ComposableMap,
  Geographies,
  Geography,
  Line,
  Marker,
  ZoomableGroup,
} from "react-simple-maps";
import type { AdminUserRow } from "../../api/admin";

const GEO_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

type BBox = { minLng: number; maxLng: number; minLat: number; maxLat: number };

const PHONE_PREFIX_TO_BBOX: Record<string, BBox> = {
  "+44": { minLng: -6, maxLng: 2, minLat: 50, maxLat: 58 },
  "+1":  { minLng: -122, maxLng: -74, minLat: 26, maxLat: 48 },
  "+61": { minLng: 114, maxLng: 153, minLat: -38, maxLat: -12 },
  "+64": { minLng: 166, maxLng: 178, minLat: -47, maxLat: -35 },
  "+353": { minLng: -10.5, maxLng: -5.5, minLat: 51.4, maxLat: 55.4 },
  "+49": { minLng: 6, maxLng: 15, minLat: 47.3, maxLat: 55 },
  "+33": { minLng: -5, maxLng: 8, minLat: 42, maxLat: 51 },
  "+34": { minLng: -9.3, maxLng: 3.3, minLat: 36, maxLat: 43.8 },
  "+39": { minLng: 6.6, maxLng: 18.5, minLat: 36.6, maxLat: 47.1 },
  "+31": { minLng: 3.4, maxLng: 7.2, minLat: 50.8, maxLat: 53.5 },
  "+32": { minLng: 2.5, maxLng: 6.4, minLat: 49.5, maxLat: 51.5 },
  "+41": { minLng: 6, maxLng: 10.5, minLat: 45.8, maxLat: 47.8 },
  "+43": { minLng: 9.5, maxLng: 17, minLat: 46.4, maxLat: 49 },
  "+46": { minLng: 11, maxLng: 24, minLat: 55.3, maxLat: 69 },
  "+47": { minLng: 4.5, maxLng: 31, minLat: 58, maxLat: 71 },
  "+45": { minLng: 8, maxLng: 15.2, minLat: 54.6, maxLat: 57.8 },
  "+358": { minLng: 20, maxLng: 32, minLat: 59.8, maxLat: 70.1 },
  "+48": { minLng: 14.1, maxLng: 24.2, minLat: 49, maxLat: 54.8 },
  "+351": { minLng: -9.5, maxLng: -6.2, minLat: 37, maxLat: 42.1 },
  "+30": { minLng: 19.4, maxLng: 29.7, minLat: 34.8, maxLat: 41.8 },
  "+420": { minLng: 12.1, maxLng: 18.9, minLat: 48.6, maxLat: 51 },
  "+36": { minLng: 16, maxLng: 22.9, minLat: 45.7, maxLat: 48.6 },
  "+40": { minLng: 20.3, maxLng: 29.7, minLat: 43.6, maxLat: 48.3 },
  "+380": { minLng: 22, maxLng: 40.2, minLat: 44.4, maxLat: 52.4 },
  "+7":  { minLng: 27, maxLng: 180, minLat: 41, maxLat: 72 },
  "+86": { minLng: 73.5, maxLng: 134.8, minLat: 18.2, maxLat: 53.6 },
  "+81": { minLng: 129.5, maxLng: 145.8, minLat: 30.4, maxLat: 45.5 },
  "+82": { minLng: 125, maxLng: 130, minLat: 33, maxLat: 38.6 },
  "+91": { minLng: 68.2, maxLng: 97.4, minLat: 8.1, maxLat: 35.5 },
  "+92": { minLng: 61, maxLng: 77.8, minLat: 23.7, maxLat: 37.1 },
  "+65": { minLng: 103.6, maxLng: 104, minLat: 1.2, maxLat: 1.5 },
  "+60": { minLng: 99.6, maxLng: 119.3, minLat: 0.9, maxLat: 7.4 },
  "+66": { minLng: 97.4, maxLng: 105.6, minLat: 5.6, maxLat: 20.5 },
  "+62": { minLng: 95, maxLng: 141, minLat: -11, maxLat: 6 },
  "+63": { minLng: 117, maxLng: 127, minLat: 5, maxLat: 19.5 },
  "+55": { minLng: -73.9, maxLng: -34.8, minLat: -33.8, maxLat: 5.3 },
  "+52": { minLng: -117.1, maxLng: -86.7, minLat: 14.5, maxLat: 32.7 },
  "+54": { minLng: -73.6, maxLng: -53.6, minLat: -55.1, maxLat: -21.8 },
  "+56": { minLng: -75.6, maxLng: -66.9, minLat: -56, maxLat: -17.5 },
  "+57": { minLng: -79, maxLng: -67, minLat: -4.2, maxLat: 12.5 },
  "+27": { minLng: 16.5, maxLng: 33, minLat: -35, maxLat: -22.1 },
  "+234": { minLng: 2.7, maxLng: 14.7, minLat: 4.3, maxLat: 14 },
  "+254": { minLng: 33.9, maxLng: 41.9, minLat: -4.7, maxLat: 5.5 },
  "+20": { minLng: 25, maxLng: 35, minLat: 22, maxLat: 31.7 },
  "+212": { minLng: -13, maxLng: -1, minLat: 27.7, maxLat: 35.9 },
  "+971": { minLng: 51.6, maxLng: 56.4, minLat: 22.6, maxLat: 26.1 },
  "+966": { minLng: 34.6, maxLng: 55.7, minLat: 16.4, maxLat: 32.2 },
  "+972": { minLng: 34.3, maxLng: 35.9, minLat: 29.5, maxLat: 33.3 },
  "+90": { minLng: 26, maxLng: 44.8, minLat: 36, maxLat: 42.1 },
};

const RING_COLORS = [
  "#a78bfa", "#34d399", "#f472b6", "#fb923c", "#38bdf8",
  "#facc15", "#4ade80", "#c084fc", "#f87171", "#2dd4bf",
  "#818cf8", "#fbbf24", "#a3e635", "#e879f9", "#67e8f9",
];

function seededRandom(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return (Math.abs(hash) % 10000) / 10000;
}

function getRingColor(id: string): string {
  const idx = Math.floor(seededRandom(id) * RING_COLORS.length);
  return RING_COLORS[idx];
}

function getInitials(email: string, company: string | null): string {
  if (company) {
    const words = company.trim().split(/\s+/);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return company.slice(0, 2).toUpperCase();
  }
  const local = email.split("@")[0];
  const parts = local.split(/[._-]/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

function getCoords(phone: string | null, seed: string): [number, number] | null {
  if (!phone) return null;
  const sorted = Object.keys(PHONE_PREFIX_TO_BBOX).sort(
    (a, b) => b.length - a.length
  );
  for (const prefix of sorted) {
    if (phone.startsWith(prefix)) {
      const box = PHONE_PREFIX_TO_BBOX[prefix];
      const rx = seededRandom(seed + "lng");
      const ry = seededRandom(seed + "lat");
      const lng = box.minLng + rx * (box.maxLng - box.minLng);
      const lat = box.minLat + ry * (box.maxLat - box.minLat);
      return [lng, lat];
    }
  }
  return null;
}

type UserMarker = {
  id: string;
  coords: [number, number];
  user: AdminUserRow;
  color: string;
  initials: string;
};

type Connection = {
  from: [number, number];
  to: [number, number];
  key: string;
};

function buildConnections(markers: UserMarker[], maxDist: number, maxLines: number): Connection[] {
  const lines: Connection[] = [];
  for (let i = 0; i < markers.length && lines.length < maxLines; i++) {
    let connected = 0;
    for (let j = i + 1; j < markers.length && lines.length < maxLines; j++) {
      if (connected >= 3) break;
      const dx = markers[i].coords[0] - markers[j].coords[0];
      const dy = markers[i].coords[1] - markers[j].coords[1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < maxDist) {
        lines.push({
          from: markers[i].coords,
          to: markers[j].coords,
          key: `${markers[i].id}-${markers[j].id}`,
        });
        connected++;
      }
    }
  }
  return lines;
}

export default function UserWorldMap({
  users,
  onUserClick,
}: {
  users: AdminUserRow[];
  onUserClick?: (userId: string) => void;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    user: AdminUserRow;
  } | null>(null);

  const markers: UserMarker[] = useMemo(() => {
    return users
      .map((u) => {
        const coords = getCoords(u.phone, u.id);
        if (!coords) return null;
        return {
          id: u.id,
          coords,
          user: u,
          color: getRingColor(u.id),
          initials: getInitials(u.email, u.company_name),
        };
      })
      .filter(Boolean) as UserMarker[];
  }, [users]);

  const connections = useMemo(
    () => buildConnections(markers, 12, 120),
    [markers]
  );

  const unmappedCount = users.length - markers.length;

  const markerScale = Math.max(0.4, 1 / Math.sqrt(zoom));
  const baseR = 5 * markerScale;
  const hoverR = 7 * markerScale;
  const glowR = 11 * markerScale;
  const fontSize = `${3.5 * markerScale}px`;
  const hoverFontSize = `${4.5 * markerScale}px`;
  const strokeW = 1.2 * markerScale;

  const handleMoveEnd = useCallback((position: { zoom: number }) => {
    setZoom(position.zoom);
  }, []);

  return (
    <div className="relative rounded-xl border border-neutral-800 bg-[#08080a] overflow-hidden">
      <div className="absolute top-3 left-4 z-10 flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-fuchsia-400 animate-pulse" />
          <span className="text-xs text-neutral-400">
            {markers.length} mapped
          </span>
        </div>
        {unmappedCount > 0 && (
          <span className="text-xs text-neutral-600">
            ({unmappedCount} without location)
          </span>
        )}
        {zoom > 1 && (
          <span className="text-[10px] text-neutral-600 tabular-nums">
            {zoom.toFixed(1)}x
          </span>
        )}
      </div>

      <ComposableMap
        projection="geoMercator"
        projectionConfig={{ scale: 140, center: [10, 30] }}
        style={{ width: "100%", height: "auto", aspectRatio: "2 / 1" }}
      >
        <ZoomableGroup onMoveEnd={handleMoveEnd} maxZoom={20}>
          <Geographies geography={GEO_URL}>
            {({ geographies }: { geographies: any[] }) =>
              geographies.map((geo: any) => (
                <Geography
                  key={geo.rsmKey}
                  geography={geo}
                  fill="#111113"
                  stroke="#1a1a1e"
                  strokeWidth={0.3}
                  style={{
                    default: { outline: "none" },
                    hover: { fill: "#151518", outline: "none" },
                    pressed: { outline: "none" },
                  }}
                />
              ))
            }
          </Geographies>

          {connections.map((c) => (
            <Line
              key={c.key}
              from={c.from}
              to={c.to}
              stroke="#0d9488"
              strokeWidth={0.2 * markerScale}
              strokeLinecap="round"
              strokeOpacity={0.2}
            />
          ))}

          {markers.map((m) => {
            const isHovered = hoveredId === m.id;
            return (
              <Marker
                key={m.id}
                coordinates={m.coords}
                onMouseEnter={(e: React.MouseEvent<SVGElement>) => {
                  setHoveredId(m.id);
                  const rect = (e.target as SVGElement).closest("svg")?.getBoundingClientRect();
                  if (rect) {
                    setTooltip({
                      x: e.clientX - rect.left,
                      y: e.clientY - rect.top - 50,
                      user: m.user,
                    });
                  }
                }}
                onMouseLeave={() => {
                  setHoveredId(null);
                  setTooltip(null);
                }}
                onClick={() => onUserClick?.(m.id)}
                style={{ cursor: "pointer" }}
              >
                {isHovered && (
                  <circle
                    r={glowR}
                    fill="none"
                    stroke={m.color}
                    strokeWidth={0.6 * markerScale}
                    opacity={0.35}
                  />
                )}
                <circle
                  r={isHovered ? hoverR : baseR}
                  fill="none"
                  stroke={m.color}
                  strokeWidth={strokeW}
                  opacity={isHovered ? 1 : 0.75}
                />
                <circle
                  r={isHovered ? hoverR - strokeW : baseR - strokeW}
                  fill="#08080a"
                />
                <text
                  textAnchor="middle"
                  y={isHovered ? hoverR * 0.35 : baseR * 0.35}
                  style={{
                    fontFamily: "system-ui, sans-serif",
                    fontSize: isHovered ? hoverFontSize : fontSize,
                    fontWeight: 700,
                    fill: m.color,
                    pointerEvents: "none",
                    userSelect: "none",
                  }}
                >
                  {m.initials}
                </text>
              </Marker>
            );
          })}
        </ZoomableGroup>
      </ComposableMap>

      {tooltip && (
        <div
          className="absolute z-20 pointer-events-none"
          style={{ left: tooltip.x, top: tooltip.y, transform: "translate(-50%, -100%)" }}
        >
          <div className="bg-neutral-900/95 backdrop-blur-sm border border-neutral-700 rounded-lg px-3 py-2.5 shadow-2xl text-xs max-w-[260px]">
            <div className="font-medium text-neutral-100 truncate">
              {tooltip.user.email}
            </div>
            {tooltip.user.company_name && (
              <div className="text-neutral-400 truncate mt-0.5">{tooltip.user.company_name}</div>
            )}
            <div className="flex items-center gap-2 mt-1.5 pt-1.5 border-t border-neutral-800">
              <span
                className={`w-2 h-2 rounded-full ${
                  tooltip.user.stripe_subscription_status === "active"
                    ? "bg-violet-400"
                    : tooltip.user.trial_ends_at &&
                      new Date(tooltip.user.trial_ends_at).getTime() > Date.now()
                    ? "bg-emerald-400"
                    : "bg-neutral-500"
                }`}
              />
              <span className="text-neutral-400 capitalize">
                {tooltip.user.stripe_subscription_status === "active"
                  ? tooltip.user.plan
                  : tooltip.user.trial_ends_at &&
                    new Date(tooltip.user.trial_ends_at).getTime() > Date.now()
                  ? "trialing"
                  : "locked"}
              </span>
              {tooltip.user.phone && (
                <span className="text-neutral-600 ml-auto">{tooltip.user.phone}</span>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="absolute bottom-3 right-4 z-10 flex items-center gap-4 text-[10px] text-neutral-500">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full border-[1.5px] border-violet-400 bg-transparent" /> paying
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full border-[1.5px] border-emerald-400 bg-transparent" /> trial
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full border-[1.5px] border-neutral-500 bg-transparent" /> locked
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-px bg-teal-500/40" /> network
        </span>
      </div>
    </div>
  );
}
