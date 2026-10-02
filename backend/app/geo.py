"""Геометрия объектов: проверка GeoJSON-полигонов и точка для маркера внутри полигона."""

import json
import math

POLYGON_TYPES = ("Polygon", "MultiPolygon")
MAX_VERTICES = 50_000


class GeometryError(ValueError):
    pass


def parse_geometry(value) -> dict | None:
    """Принимает GeoJSON-геометрию (объект или JSON-строку) или Feature; возвращает Polygon/MultiPolygon либо None для точки."""
    if value is None or value == "":
        return None
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            raise GeometryError("геометрия — не GeoJSON")
    if not isinstance(value, dict):
        raise GeometryError("геометрия — не GeoJSON")
    if value.get("type") == "Feature":
        value = value.get("geometry") or {}
    gtype = value.get("type")
    if gtype == "Point":
        return None
    if gtype not in POLYGON_TYPES:
        raise GeometryError(f"тип геометрии «{gtype}» не поддерживается (нужен Polygon, MultiPolygon или Point)")
    polys = [value.get("coordinates")] if gtype == "Polygon" else value.get("coordinates")
    if not isinstance(polys, list) or not polys:
        raise GeometryError("у полигона нет координат")
    clean, vertices = [], 0
    for poly in polys:
        if not isinstance(poly, list) or not poly:
            raise GeometryError("полигон без контура")
        rings = []
        for ring in poly:
            if not isinstance(ring, list) or len(ring) < 3:
                raise GeometryError("контур полигона меньше трёх точек")
            pts = []
            for pt in ring:
                try:
                    lon, lat = float(pt[0]), float(pt[1])
                except (TypeError, ValueError, IndexError):
                    raise GeometryError("координаты полигона — не числа")
                if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                    raise GeometryError("координаты полигона вне WGS-84 (нужны долгота и широта в градусах)")
                pts.append([round(lon, 7), round(lat, 7)])
            if pts[0] != pts[-1]:
                pts.append(pts[0])  # замыкаем контур
            if len(pts) < 4:
                raise GeometryError("контур полигона меньше трёх точек")
            vertices += len(pts)
            rings.append(pts)
        clean.append(rings)
    if vertices > MAX_VERTICES:
        raise GeometryError(f"слишком подробный полигон: {vertices} вершин (не больше {MAX_VERTICES})")
    if len(clean) == 1:
        return {"type": "Polygon", "coordinates": clean[0]}
    return {"type": "MultiPolygon", "coordinates": clean}


def dumps(geometry: dict | None) -> str | None:
    return json.dumps(geometry, separators=(",", ":")) if geometry else None


def _ring_area(ring) -> float:
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:])) / 2


def _inside(x, y, ring) -> bool:
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def _in_polygon(x, y, rings) -> bool:
    return _inside(x, y, rings[0]) and not any(_inside(x, y, hole) for hole in rings[1:])


def label_point(geometry: dict) -> tuple[float, float]:
    """Точка для маркера: центр тяжести самого большого контура, а если он вне полигона (вогнутая форма или дыра) —
    середина самого широкого отрезка горизонтали через центр, лежащего внутри полигона. Возвращает (lat, lon)."""
    polys = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    rings = max(polys, key=lambda p: abs(_ring_area(p[0])))
    outer = rings[0]
    a = _ring_area(outer)
    if abs(a) < 1e-15:
        cx = sum(p[0] for p in outer[:-1]) / (len(outer) - 1)
        cy = sum(p[1] for p in outer[:-1]) / (len(outer) - 1)
    else:
        cx = sum((x1 + x2) * (x1 * y2 - x2 * y1) for (x1, y1), (x2, y2) in zip(outer, outer[1:])) / (6 * a)
        cy = sum((y1 + y2) * (x1 * y2 - x2 * y1) for (x1, y1), (x2, y2) in zip(outer, outer[1:])) / (6 * a)
    if _in_polygon(cx, cy, rings):
        return cy, cx
    xs = []
    for ring in rings:
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            if (y1 > cy) != (y2 > cy):
                xs.append((x2 - x1) * (cy - y1) / (y2 - y1) + x1)
    xs.sort()
    best = None
    for left, right in zip(xs[0::2], xs[1::2]):
        if best is None or right - left > best[1] - best[0]:
            best = (left, right)
    if best and _in_polygon((best[0] + best[1]) / 2, cy, rings):
        return cy, (best[0] + best[1]) / 2
    return outer[0][1], outer[0][0]


def read_geojson(path) -> dict:
    """GeoJSON → таблица в формате read_table: свойства объектов — колонки, плюс центр и геометрия."""
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (ValueError, UnicodeDecodeError) as e:
        raise GeometryError(f"файл не читается как GeoJSON: {e}")
    if isinstance(data, list):
        features = data
    elif data.get("type") == "FeatureCollection":
        features = data.get("features") or []
    elif data.get("type") == "Feature":
        features = [data]
    else:
        raise GeometryError("ожидается FeatureCollection, Feature или список объектов")
    crs = (data.get("crs") or {}).get("properties", {}).get("name", "") if isinstance(data, dict) else ""
    if crs and "4326" not in crs and "CRS84" not in crs:
        raise GeometryError(f"система координат {crs} не поддерживается — нужна WGS-84 (EPSG:4326)")
    keys: list[str] = []
    for f in features:
        for k in (f.get("properties") or {}):
            if k not in keys:
                keys.append(k)
    headers = ["Широта (центр)", "Долгота (центр)", "Геометрия (GeoJSON)"] + keys
    rows = []
    for i, f in enumerate(features, start=1):
        props = f.get("properties") or {}
        geom = f.get("geometry") or {}
        lat = lon = geom_cell = None
        if geom.get("type") == "Point":
            try:
                lon, lat = float(geom["coordinates"][0]), float(geom["coordinates"][1])
            except (TypeError, ValueError, IndexError, KeyError):
                pass
        elif geom:
            geom_cell = json.dumps(geom, separators=(",", ":"))  # проверка и центр — при разборе строки
        values = [lat, lon, geom_cell] + [
            json.dumps(props.get(k), ensure_ascii=False) if isinstance(props.get(k), (dict, list)) else props.get(k)
            for k in keys
        ]
        rows.append((i, values))
    return {"GeoJSON": {"headers": headers, "rows": rows}}


def area_m2(geometry: dict) -> float:
    """Площадь на сфере (как turf.area), м²."""
    radius = 6378137.0

    def ring(coords):
        total = 0.0
        for (x1, y1), (x2, y2) in zip(coords, coords[1:]):
            total += math.radians(x2 - x1) * (2 + math.sin(math.radians(y1)) + math.sin(math.radians(y2)))
        return abs(total * radius * radius / 2)

    polys = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    return sum(ring(p[0]) - sum(ring(h) for h in p[1:]) for p in polys)
