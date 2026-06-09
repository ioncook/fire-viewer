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
    merged_high = []
    merged_low = []
    
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
                
                props = {
                    "y": int(row['FIRE_YEAR_INT']),
                    "n": row['INCIDENT'] or 'Unnamed',
                    "ag": row['AGENCY'] or '',
                    "ac": round(float(row['GIS_ACRES']), 1),
                    "c": 14,
                    "cl": "Unknown",
                    "ad": row['alarm_str'],
                    "cd": "",
                    "st": code  # State code
                }
                
                try:
                    # Calculate bbox
                    bbox = list(geom.bounds) if geom else None

                    # High resolution (0.0003 degrees ~30m detail)
                    geom_high = geom.simplify(0.0003, preserve_topology=True)
                    if geom_high and not geom_high.is_empty:
                        merged_high.append({
                            "type": "Feature",
                            "properties": props.copy(),
                            "geometry": mapping(geom_high),
                            "bbox": bbox
                        })
                    
                    # Low resolution (0.006 degrees ~660m detail)
                    geom_low = geom.simplify(0.006, preserve_topology=True)
                    if geom_low and not geom_low.is_empty:
                        merged_low.append({
                            "type": "Feature",
                            "properties": props.copy(),
                            "geometry": mapping(geom_low),
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

    print("Deduplicating and writing high-resolution state perimeters...")
    states_dir = os.path.join(OUTPUT_DIR, "states")
    os.makedirs(states_dir, exist_ok=True)
    # Group by state code and write
    for code in STATES.keys():
        state_high_features = [f for f in merged_high if f['properties']['st'] == code]
        if len(state_high_features) > 0:
            print(f"  Deduplicating high-res perimeters for {code}...")
            deduped_state = deduplicate(state_high_features)
            out_path_high = os.path.join(states_dir, f"fires_{code}.geojson")
            print(f"  Writing high-res perimeters to {out_path_high}...")
            with open(out_path_high, 'w') as f:
                json.dump({"type": "FeatureCollection", "features": deduped_state}, f, separators=(',', ':'))
            size_mb = os.path.getsize(out_path_high) / (1024 * 1024)
            print(f"  Created: {size_mb:.2f} MB")

    print("Deduplicating and writing low-resolution perimeters...")
    low_features = deduplicate(merged_low)
    print(f"  Low-res reduced to {len(low_features)} unique perimeters.")

    # Write the combined low-res GeoJSON file
    out_path_low = os.path.join(OUTPUT_DIR, "fires_lowres.geojson")
    print(f"Writing low-res perimeters to {out_path_low}...")
    with open(out_path_low, 'w') as f:
        json.dump({"type": "FeatureCollection", "features": low_features}, f, separators=(',', ':'))
    size_mb_low = os.path.getsize(out_path_low) / (1024 * 1024)
    print(f"Low-res created: {size_mb_low:.2f} MB")

if __name__ == "__main__":
    main()
