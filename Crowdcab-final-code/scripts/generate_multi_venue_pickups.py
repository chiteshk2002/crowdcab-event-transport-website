import csv
import json
import math
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path


DATA_DIR = Path(__file__).resolve().parents[1] / "data"
EARTH_RADIUS_KM = 6371
TARGET_GENERATED_ROWS = 160
SAMPLE_SPACING_KM = 0.045

FIELDS = [
    "venue_id",
    "pickup_point_id",
    "label",
    "suburb",
    "street",
    "latitude",
    "longitude",
    "candidate_pickup_point",
    "source_dataset",
    "official_event_role",
    "nearby_road_count",
    "nearby_major_road_count",
    "nearby_crossing_count",
    "nearby_signal_count",
    "access_complexity_score",
    "distance_to_venue_km",
    "complexity_band",
    "walk_band",
    "safety_score",
    "accessibility_score",
    "driver_access_score",
    "base_congestion_score",
    "notes",
]

VENUES = {
    "chandler_sports_precinct": {
        "name": "Chandler Sports Precinct",
        "prefix": "chandler",
        "lat": -27.511350,
        "lng": 153.147600,
        "suburbs": [("Chandler", -27.511350, 153.147600), ("Carina", -27.4927, 153.0945), ("Belmont", -27.5001, 153.1330)],
        "source": "osm_chandler_road_candidates",
    },
    "brisbane_showgrounds": {
        "name": "Brisbane Showgrounds",
        "prefix": "showgrounds",
        "lat": -27.450800,
        "lng": 153.032400,
        "suburbs": [("Bowen Hills", -27.450800, 153.032400), ("Fortitude Valley", -27.4570, 153.0350), ("Herston", -27.4440, 153.0205)],
        "source": "local_road_showgrounds_candidates",
    },
    "ballymore_stadium": {
        "name": "Ballymore Stadium",
        "prefix": "ballymore",
        "lat": -27.439800,
        "lng": 153.016100,
        "suburbs": [("Herston", -27.439800, 153.016100), ("Kelvin Grove", -27.4497, 153.0130), ("Newmarket", -27.4368, 153.0072)],
        "source": "local_road_ballymore_candidates",
    },
    "brisbane_arena": {
        "name": "Brisbane Arena",
        "prefix": "arena",
        "lat": -27.464300,
        "lng": 153.018000,
        "suburbs": [("Brisbane City", -27.464300, 153.018000), ("Spring Hill", -27.4616, 153.0255), ("South Brisbane", -27.4741, 153.0180)],
        "source": "local_road_arena_candidates",
    },
    "brisbane_aquatic_centre": {
        "name": "Brisbane Aquatic Centre",
        "prefix": "aquatic",
        "lat": -27.512045,
        "lng": 153.148650,
        "suburbs": [("Chandler", -27.512045, 153.148650), ("Belmont", -27.5001, 153.1330), ("Carina", -27.4927, 153.0945)],
        "source": "osm_aquatic_road_candidates",
    },
}

ALLOWED_HIGHWAYS = {
    "residential",
    "tertiary",
    "secondary",
    "primary",
    "unclassified",
    "service",
    "living_street",
}
MAJOR_HIGHWAYS = {"tertiary", "secondary", "primary", "trunk"}


def km_between(a_lat, a_lng, b_lat, b_lng):
    dlat = math.radians(b_lat - a_lat)
    dlng = math.radians(b_lng - a_lng)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(a_lat))
        * math.cos(math.radians(b_lat))
        * math.sin(dlng / 2) ** 2
    )
    return 2 * EARTH_RADIUS_KM * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def slug(value):
    text = "".join(ch.lower() if ch.isalnum() else "_" for ch in value).strip("_")
    return "_".join(part for part in text.split("_") if part)[:40] or "pickup"


def walk_band(distance_km):
    if distance_km < 0.25:
        return "under-250m"
    if distance_km < 0.5:
        return "250m-500m"
    if distance_km <= 1:
        return "500m-1km"
    if distance_km <= 1.5:
        return "1-1.5km"
    return "1.5-2km"


def complexity_band(value):
    if value < 110:
        return "Low"
    if value < 160:
        return "Medium"
    if value < 220:
        return "High"
    return "Very High"


def nearest_suburb(lat, lng, venue):
    return min(
        venue["suburbs"],
        key=lambda item: km_between(lat, lng, item[1], item[2]),
    )[0]


def load_local_road_points():
    path = DATA_DIR / "road_network_points.csv"
    rows = list(csv.DictReader(path.open(encoding="utf-8-sig")))
    grouped = defaultdict(list)
    for row in rows:
        try:
            lat = float(row["latitude"])
            lng = float(row["longitude"])
        except (TypeError, ValueError):
            continue
        highway = row.get("highway") or "road"
        if highway not in ALLOWED_HIGHWAYS and highway != "trunk":
            continue
        grouped[row.get("element_id") or f"{lat},{lng}"].append(
            {
                "lat": lat,
                "lng": lng,
                "name": row.get("name") or f"Unnamed {highway.title()} Road",
                "highway": highway,
            }
        )
    return [
        {
            "id": element_id,
            "name": points[0]["name"],
            "highway": points[0]["highway"],
            "points": [(point["lat"], point["lng"]) for point in points],
        }
        for element_id, points in grouped.items()
    ]


def fetch_osm_roads(venue):
    quote = '"'
    query = (
        "[out:json][timeout:30];"
        f"(way(around:2200,{venue['lat']},{venue['lng']})[{quote}highway{quote}];"
        f"node(around:2200,{venue['lat']},{venue['lng']})[{quote}highway{quote}={quote}traffic_signals{quote}];"
        f"node(around:2200,{venue['lat']},{venue['lng']})[{quote}highway{quote}={quote}crossing{quote}];);out geom;"
    )
    request = urllib.request.Request(
        "https://overpass-api.de/api/interpreter",
        data=urllib.parse.urlencode({"data": query}).encode(),
        headers={"User-Agent": "CrowdCab local multi-venue research"},
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.loads(response.read())


def osm_to_ways(osm):
    ways = []
    for element in osm.get("elements", []):
        if element.get("type") != "way":
            continue
        tags = element.get("tags") or {}
        highway = tags.get("highway", "")
        geometry = element.get("geometry") or []
        if highway not in ALLOWED_HIGHWAYS or not geometry:
            continue
        ways.append(
            {
                "id": element.get("id"),
                "name": tags.get("name") or f"Unnamed {highway.title()} Road",
                "highway": highway,
                "points": [(float(point["lat"]), float(point["lon"])) for point in geometry],
            }
        )
    return ways


def nearby_counts(point, road_points):
    lat, lng = point
    nearby_roads = 0
    nearby_major = 0
    for road_lat, road_lng, highway in road_points:
        distance = km_between(lat, lng, road_lat, road_lng)
        if distance <= 0.25:
            nearby_roads += 1
        if highway in MAJOR_HIGHWAYS and distance <= 0.35:
            nearby_major += 1
    return nearby_roads, nearby_major


def score_candidate(candidate):
    distance = candidate["distance"]
    road_class = candidate["highway"]
    nearby_roads = candidate["nearby_roads"]
    nearby_major = candidate["nearby_major"]
    distance_penalty = max(0, distance - 1)
    major_bonus = 18 if road_class in {"secondary", "tertiary"} else 8 if road_class == "primary" else 0
    service_penalty = 16 if road_class == "service" else 0
    primary_penalty = 8 if road_class == "primary" else 0

    complexity = round(95 + nearby_major * 3.8 + service_penalty + distance_penalty * 35, 1)
    safety = max(45, min(94, 88 - primary_penalty - distance_penalty * 8 - nearby_major * 0.3))
    accessibility = max(42, min(96, 90 - distance * 11 - service_penalty * 0.35))
    driver_access = max(35, min(96, 56 + min(nearby_roads, 38) * 0.75 + min(nearby_major, 14) * 2.1 + major_bonus - service_penalty))
    congestion = max(35, min(90, 78 - nearby_major * 1.25 - primary_penalty))

    candidate.update(
        {
            "complexity": complexity,
            "safety": round(safety, 1),
            "accessibility": round(accessibility, 1),
            "driver_access": round(driver_access, 1),
            "congestion": round(congestion, 1),
        }
    )
    return candidate


def build_candidates(venue_id, venue, ways):
    road_points = [
        (lat, lng, way["highway"])
        for way in ways
        for lat, lng in way["points"]
    ]
    candidates = []
    seen = []

    for way in ways:
        if not way["points"]:
            continue
        samples = []
        last = None
        accumulated = 0
        for point in way["points"]:
            if last is None:
                last = point
                samples.append(point)
                continue
            accumulated += km_between(last[0], last[1], point[0], point[1])
            last = point
            if accumulated >= SAMPLE_SPACING_KM:
                samples.append(point)
                accumulated = 0

        for point in samples:
            distance = km_between(venue["lat"], venue["lng"], point[0], point[1])
            if distance > 2:
                continue
            if any(km_between(point[0], point[1], other[0], other[1]) < 0.03 for other in seen):
                continue
            seen.append(point)
            nearby_roads, nearby_major = nearby_counts(point, road_points)
            candidates.append(
                score_candidate(
                    {
                        "point": point,
                        "distance": distance,
                        "name": way["name"],
                        "highway": way["highway"],
                        "nearby_roads": nearby_roads,
                        "nearby_major": nearby_major,
                    }
                )
            )

    candidates.sort(key=lambda item: (item["distance"] > 1, item["distance"], -item["driver_access"], item["name"]))
    if len(candidates) < TARGET_GENERATED_ROWS:
        raise RuntimeError(f"{venue_id} produced only {len(candidates)} candidates")
    return candidates[:TARGET_GENERATED_ROWS]


def candidate_to_row(venue_id, venue, candidate, index):
    lat, lng = candidate["point"]
    suburb = nearest_suburb(lat, lng, venue)
    label = f"{candidate['name'].upper()} {venue['prefix'].upper()} CANDIDATE {index:03d} | {suburb.upper()}"
    return {
        "venue_id": venue_id,
        "pickup_point_id": f"{venue['prefix']}_osm_{index:03d}_{slug(candidate['name'])}",
        "label": label,
        "suburb": suburb,
        "street": candidate["name"],
        "latitude": f"{lat:.6f}",
        "longitude": f"{lng:.6f}",
        "candidate_pickup_point": "1",
        "source_dataset": venue["source"],
        "official_event_role": "raw_road_candidate",
        "nearby_road_count": candidate["nearby_roads"],
        "nearby_major_road_count": candidate["nearby_major"],
        "nearby_crossing_count": 0,
        "nearby_signal_count": 0,
        "access_complexity_score": candidate["complexity"],
        "distance_to_venue_km": round(candidate["distance"], 3),
        "complexity_band": complexity_band(candidate["complexity"]),
        "walk_band": walk_band(candidate["distance"]),
        "safety_score": candidate["safety"],
        "accessibility_score": candidate["accessibility"],
        "driver_access_score": candidate["driver_access"],
        "base_congestion_score": candidate["congestion"],
        "notes": (
            f"Generated from road geometry within 2 km of {venue['name']}. "
            f"Road class: {candidate['highway']}. Requires final human review before preferred event use."
        ),
    }


def main():
    path = DATA_DIR / "venue_pickup_points.csv"
    existing = list(csv.DictReader(path.open(encoding="utf-8-sig")))
    generated_sources = {venue["source"] for venue in VENUES.values()}
    preserved_rows = [row for row in existing if row.get("source_dataset") not in generated_sources]
    local_ways = load_local_road_points()
    all_generated = []

    for venue_id, venue in VENUES.items():
        local_nearby = [
            way for way in local_ways
            if any(km_between(venue["lat"], venue["lng"], lat, lng) <= 2.2 for lat, lng in way["points"])
        ]
        if len(local_nearby) >= 20:
            ways = local_nearby
            source = "local"
        else:
            ways = osm_to_ways(fetch_osm_roads(venue))
            source = "osm"
        candidates = build_candidates(venue_id, venue, ways)
        rows = [candidate_to_row(venue_id, venue, candidate, index) for index, candidate in enumerate(candidates, start=1)]
        all_generated.extend(rows)
        print(f"{venue_id}: {len(rows)} candidates from {source}")

    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(preserved_rows + all_generated)

    print(f"preserved rows: {len(preserved_rows)}")
    print(f"generated rows: {len(all_generated)}")
    print(f"total csv rows: {len(preserved_rows) + len(all_generated)}")


if __name__ == "__main__":
    main()
