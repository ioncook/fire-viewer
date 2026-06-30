#!/usr/bin/env python3
import os
import json
import urllib.request
import geopandas as gpd
from shapely.geometry import mapping
import warnings
warnings.filterwarnings('ignore')

GDB_PATH = "firedata.gdb"
LAYER = "InteragencyFirePerimeterHistory"
OUTPUT_DIR = "docs"

def round_coordinates(geom_dict, precision=5):
    if not geom_dict:
        return geom_dict
    
    def round_coords(coords):
        if isinstance(coords, (list, tuple)):
            if len(coords) > 0 and isinstance(coords[0], (int, float)):
                return [round(float(c), precision) for c in coords]
            else:
                return [round_coords(c) for c in coords]
        return coords

    if 'coordinates' in geom_dict:
        geom_dict['coordinates'] = round_coords(geom_dict['coordinates'])
    return geom_dict

STATES = {
    'CA': 'California',
    'OR': 'Oregon',
    'WA': 'Washington',
    'ID': 'Idaho',
    'NV': 'Nevada',
    'UT': 'Utah',
    'AZ': 'Arizona',
    'NM': 'New Mexico',
    'CO': 'Colorado',
    'WY': 'Wyoming',
    'MT': 'Montana',
    'AK': 'Alaska'
}

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    # 1. Download and filter US States GeoJSON
    print("Downloading US states geojson...")
    states_url = 'https://raw.githubusercontent.com/python-visualization/folium/main/examples/data/us-states.json'
    try:
        req = urllib.request.Request(states_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as response:
            states_data = json.loads(response.read().decode('utf-8'))
            
        # Filter only the 12 states we support
        filtered_features = []
        for feat in states_data['features']:
            state_code = feat.get('id')
            if state_code in STATES:
                # Store the state name inside properties
                feat['properties']['state_code'] = state_code
                filtered_features.append(feat)
                
        states_geojson = {
            "type": "FeatureCollection",
            "features": filtered_features
        }
        
        states_out = os.path.join(OUTPUT_DIR, "us_states.geojson")
        with open(states_out, 'w') as f:
            json.dump(states_geojson, f, separators=(',', ':'))
        print(f"Saved filtered US states to {states_out}")
    except Exception as e:
        print(f"Error downloading states geojson: {e}")

    columns = ['FIRE_YEAR_INT', 'INCIDENT', 'AGENCY', 'GIS_ACRES', 'UNIT_ID', 'DATE_CUR', 'geometry']
    merged_low = []
    merged_mid = []
    merged_high = []
    fire_id_map = {}
    next_fire_id = 1
    
    print("Reading and simplifying state-by-state perimeters...")
    for code, name in STATES.items():
        print(f"Processing {name} ({code})...")
        try:
            query = f"UNIT_ID LIKE '{code}%'"
            gdf = gpd.read_file(
                GDB_PATH, 
                layer=LAYER, 
                where=query, 
                columns=columns,
                engine="pyogrio"
            )
            
            if len(gdf) == 0:
                print(f"  No records found for {code}.")
                continue
                
            gdf = gdf.to_crs("EPSG:4326")
            
            # Clean
            gdf['FIRE_YEAR_INT'] = gdf['FIRE_YEAR_INT'].fillna(0).astype(int)
            gdf['GIS_ACRES'] = gdf['GIS_ACRES'].fillna(0).round(1)
            gdf['INCIDENT'] = gdf['INCIDENT'].fillna('Unnamed').str.strip().str.title()
            gdf['AGENCY'] = gdf['AGENCY'].fillna('').str.strip()
            
            def format_date_cur(d):
                if d is None or str(d) == 'nan' or len(str(d)) < 8:
                    return ''
                s = str(d)
                return f"{s[:4]}-{s[4:6]}-{s[6:8]}"
            gdf['alarm_str'] = gdf['DATE_CUR'].apply(format_date_cur)
            
            state_count = 0
            for _, row in gdf.iterrows():
                geom = row['geometry']
                if geom is None or geom.is_empty:
                    continue
                
                alarm_str = row['alarm_str']
                se = 4 # Default to Winter (4)
                if alarm_str and len(alarm_str) >= 7:
                    try:
                        m = int(alarm_str[5:7])
                        if 3 <= m <= 5:
                            se = 1      # Spring
                        elif 6 <= m <= 8:
                            se = 2      # Summer
                        elif 9 <= m <= 11:
                            se = 3      # Fall
                    except:
                        pass

                props = {
                    "y": int(row['FIRE_YEAR_INT']),
                    "n": row['INCIDENT'] or 'Unnamed',
                    "ag": row['AGENCY'] or '',
                    "ac": round(float(row['GIS_ACRES']), 1),
                    "c": 14,
                    "cl": "Unknown",
                    "ad": alarm_str,
                    "cd": "",
                    "st": code,  # State code
                    "se": se
                }

                # Stable unique integer ID based on (year, name, state)
                key = (props['y'], props['n'].lower(), props['st'])
                if key not in fire_id_map:
                    fire_id_map[key] = next_fire_id
                    next_fire_id += 1
                fire_id = fire_id_map[key]
                
                try:
                    # Calculate bbox rounded to 5 decimals
                    bbox = [round(x, 5) for x in geom.bounds] if geom else None

                    # 1. Low resolution (0.008 degrees ~880m detail)
                    geom_low = geom.simplify(0.008, preserve_topology=True)
                    if geom_low and not geom_low.is_empty:
                        geom_low = geom_low.buffer(0)
                        if geom_low and not geom_low.is_empty:
                            merged_low.append({
                                "type": "Feature",
                                "id": fire_id,
                                "properties": props.copy(),
                                "geometry": round_coordinates(mapping(geom_low), 5),
                                "bbox": bbox
                            })

                    # 2. Mid resolution (0.002 degrees ~220m detail)
                    geom_mid = geom.simplify(0.002, preserve_topology=True)
                    if geom_mid and not geom_mid.is_empty:
                        geom_mid = geom_mid.buffer(0)
                        if geom_mid and not geom_mid.is_empty:
                            merged_mid.append({
                                "type": "Feature",
                                "id": fire_id,
                                "properties": props.copy(),
                                "geometry": round_coordinates(mapping(geom_mid), 5),
                                "bbox": bbox
                            })

                    # 3. High resolution (0.0003 degrees ~30m detail)
                    geom_high = geom.simplify(0.0003, preserve_topology=True)
                    if geom_high and not geom_high.is_empty:
                        geom_high = geom_high.buffer(0)
                        if geom_high and not geom_high.is_empty:
                            merged_high.append({
                                "type": "Feature",
                                "id": fire_id,
                                "properties": props.copy(),
                                "geometry": round_coordinates(mapping(geom_high), 5),
                                "bbox": bbox
                            })
                    state_count += 1
                except:
                    pass
            print(f"  Added {state_count} perimeters.")
        except Exception as e:
            print(f"  Error processing {code}: {e}")
            
    # Deduplicate function
    def deduplicate(features):
        print("  Deduplicating features...")
        deduped = {}
        for feat in features:
            props = feat['properties']
            key = (props['y'], props['n'].lower(), props['st'])
            if key not in deduped:
                deduped[key] = feat
            else:
                existing = deduped[key]
                dates = [d for d in [existing['properties']['ad'], props['ad']] if d]
                earliest_date = min(dates) if dates else ''
                if props['ac'] > existing['properties']['ac']:
                    feat['properties']['ad'] = earliest_date
                    deduped[key] = feat
                else:
                    existing['properties']['ad'] = earliest_date
        return list(deduped.values())

    print("Deduplicating low-resolution perimeters...")
    low_features = deduplicate(merged_low)
    out_path_low = os.path.join(OUTPUT_DIR, "fires_lowres.geojson")
    print(f"Writing low-res perimeters to {out_path_low}...")
    with open(out_path_low, 'w') as f:
        json.dump({"type": "FeatureCollection", "features": low_features}, f, separators=(',', ':'))
    size_mb_low = os.path.getsize(out_path_low) / (1024 * 1024)
    print(f"Low-res created: {size_mb_low:.2f} MB ({len(low_features)} features)")

    # Write state-by-state mid-res and high-res polygons
    states_dir = os.path.join(OUTPUT_DIR, "states")
    os.makedirs(states_dir, exist_ok=True)
    for code in STATES.keys():
        # Mid-res
        state_mid = [f for f in merged_mid if f['properties']['st'] == code]
        if len(state_mid) > 0:
            print(f"  Deduplicating mid-res perimeters for {code}...")
            deduped_mid = deduplicate(state_mid)
            out_path_mid = os.path.join(states_dir, f"fires_midres_{code}.geojson")
            print(f"  Writing mid-res perimeters to {out_path_mid}...")
            with open(out_path_mid, 'w') as f:
                json.dump({"type": "FeatureCollection", "features": deduped_mid}, f, separators=(',', ':'))
            size_mb = os.path.getsize(out_path_mid) / (1024 * 1024)
            print(f"  Created Midres: {size_mb:.2f} MB")

        # High-res
        state_high = [f for f in merged_high if f['properties']['st'] == code]
        if len(state_high) > 0:
            print(f"  Deduplicating high-res perimeters for {code}...")
            deduped_high = deduplicate(state_high)
            out_path_high = os.path.join(states_dir, f"fires_highres_{code}.geojson")
            print(f"  Writing high-res perimeters to {out_path_high}...")
            with open(out_path_high, 'w') as f:
                json.dump({"type": "FeatureCollection", "features": deduped_high}, f, separators=(',', ':'))
            size_mb = os.path.getsize(out_path_high) / (1024 * 1024)
            print(f"  Created Highres: {size_mb:.2f} MB")

if __name__ == "__main__":
    main()
