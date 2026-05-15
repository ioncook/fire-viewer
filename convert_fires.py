#!/usr/bin/env python3
"""
Convert Cal Fire FRAP GDB to optimized GeoJSON for the fire-viewer web app.
Produces:
  - docs/fires.geojson  (simplified perimeters with key attributes)
"""

import json
import sys
import os
import math

import geopandas as gpd
from shapely.geometry import mapping, MultiPolygon, Polygon
import warnings
warnings.filterwarnings('ignore')

GDB_PATH = "/home/ionc/Documents/fire-viewer/fire25_1.gdb"
LAYER = "firep25_1"
OUTPUT_DIR = "/home/ionc/Documents/fire-viewer/docs"

# Cal Fire cause code lookup
CAUSE_LABELS = {
    1: "Lightning",
    2: "Equipment Use",
    3: "Smoking",
    4: "Campfire",
    5: "Debris",
    6: "Railroad",
    7: "Arson",
    8: "Playing with Fire",
    9: "Miscellaneous",
    10: "Vehicle",
    11: "Power Line",
    12: "Firefighter Training",
    13: "Non-Firefighter Training",
    14: "Unknown",
    15: "Structure",
    16: "Aircraft",
    17: "Escaped Prescribed Burn",
    18: "Illegal Alien Campfire",
    19: "Other",
}

def simplify_geometry(geom, tolerance=200):
    """Simplify geometry with given tolerance (meters, since CRS is EPSG:3310)."""
    simplified = geom.simplify(tolerance, preserve_topology=True)
    if simplified.is_empty:
        return geom.simplify(tolerance * 4, preserve_topology=True)
    return simplified

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print("Reading fire perimeters from GDB...")
    columns = ['YEAR_', 'STATE', 'AGENCY', 'UNIT_ID', 'FIRE_NAME', 
               'ALARM_DATE', 'CONT_DATE', 'CAUSE', 'GIS_ACRES', 'geometry']
    
    gdf = gpd.read_file(GDB_PATH, layer=LAYER, columns=columns)
    print(f"  Loaded {len(gdf)} fire perimeters")
    print(f"  CRS: {gdf.crs}")
    print(f"  Year range: {gdf['YEAR_'].min()} - {gdf['YEAR_'].max()}")

    # Reproject to WGS84 for web use
    print("Reprojecting to WGS84...")
    gdf = gdf.to_crs("EPSG:4326")

    # Clean up data
    gdf['YEAR_'] = gdf['YEAR_'].fillna(0).astype(int)
    gdf['GIS_ACRES'] = gdf['GIS_ACRES'].fillna(0).round(1)
    gdf['FIRE_NAME'] = gdf['FIRE_NAME'].fillna('').str.strip().str.title()
    gdf['AGENCY'] = gdf['AGENCY'].fillna('').str.strip()
    gdf['CAUSE'] = gdf['CAUSE'].fillna(14).astype(int)

    # Format dates
    def fmt_date(d):
        if d is None or str(d) == 'NaT':
            return ''
        try:
            return str(d)[:10]
        except:
            return ''

    gdf['alarm_str'] = gdf['ALARM_DATE'].apply(fmt_date)
    gdf['cont_str'] = gdf['CONT_DATE'].apply(fmt_date)

    # Filter out records with invalid year
    valid = gdf[gdf['YEAR_'] >= 1878].copy()
    print(f"  Valid records (year >= 1878): {len(valid)}")

    # Sort by size - smaller fires (process big ones first in rendering)
    valid = valid.sort_values('GIS_ACRES', ascending=True)

    # Simplify geometries (150m tolerance preserves shape while reducing file size significantly)
    print("Simplifying geometries...")
    SIMPLIFY_TOLERANCE = 0.001  # ~100m in degrees at California lat
    valid['geometry'] = valid['geometry'].simplify(SIMPLIFY_TOLERANCE, preserve_topology=True)

    # Remove very tiny/invalid geometries
    valid = valid[~valid['geometry'].is_empty]
    valid = valid[valid['geometry'].is_valid | valid['geometry'].apply(lambda g: g.buffer(0).is_valid)]
    valid['geometry'] = valid['geometry'].apply(lambda g: g.buffer(0) if not g.is_valid else g)

    print(f"  After simplification: {len(valid)} features")

    # Build GeoJSON features
    print("Building GeoJSON...")
    features = []
    for _, row in valid.iterrows():
        geom = row['geometry']
        if geom is None or geom.is_empty:
            continue

        year = int(row['YEAR_'])
        cause_id = int(row['CAUSE']) if row['CAUSE'] else 14
        cause_label = CAUSE_LABELS.get(cause_id, "Unknown")

        # Compute rough bounding box center for quick lookups
        bounds = geom.bounds  # (minx, miny, maxx, maxy)
        cx = (bounds[0] + bounds[2]) / 2
        cy = (bounds[1] + bounds[3]) / 2

        props = {
            "y": year,
            "n": row['FIRE_NAME'] or 'Unnamed',
            "ag": row['AGENCY'] or '',
            "ac": round(float(row['GIS_ACRES']), 1),
            "c": cause_id,
            "cl": cause_label,
            "ad": row['alarm_str'],
            "cd": row['cont_str'],
        }

        try:
            feat = {
                "type": "Feature",
                "properties": props,
                "geometry": mapping(geom)
            }
            features.append(feat)
        except Exception as e:
            print(f"  Warning: skipping feature due to: {e}")

    geojson = {
        "type": "FeatureCollection",
        "features": features
    }

    out_path = os.path.join(OUTPUT_DIR, "fires.geojson")
    print(f"Writing {len(features)} features to {out_path}...")
    with open(out_path, 'w') as f:
        json.dump(geojson, f, separators=(',', ':'))

    size_mb = os.path.getsize(out_path) / (1024 * 1024)
    print(f"  Done! File size: {size_mb:.1f} MB")

    # Print year distribution stats
    year_counts = valid['YEAR_'].value_counts().sort_index()
    print(f"\nDecade summary:")
    for decade_start in range(1870, 2030, 10):
        decade_end = decade_start + 9
        count = year_counts[(year_counts.index >= decade_start) & (year_counts.index <= decade_end)].sum()
        if count > 0:
            total_acres = valid[(valid['YEAR_'] >= decade_start) & (valid['YEAR_'] <= decade_end)]['GIS_ACRES'].sum()
            print(f"  {decade_start}s: {count} fires, {total_acres:,.0f} acres")

if __name__ == "__main__":
    main()
