"""
Astro Emotion Engine — CLI Entry Point

Command-line interface for the astro engine. Subcommands:
  - ``setup-ephemeris`` — Create the directory for Swiss Ephemeris data files.
  - ``validate-natal``  — Validate a natal profile JSON file against the schema.
  - ``compute``         — Run the full emotion engine pipeline and print JSON output.

Usage: ``python -m astro_emotion_engine.cli.main compute --natal profile.json``
"""

import argparse
import sys
import json
import os
from datetime import datetime
from dateutil import parser
from ..ephemeris.swisseph_provider import SwissEphProvider
from ..engine import AstroEmotionEngine
from ..schemas.natal import NatalProfile, GeoLocation
from ..schemas.request import EmotionRequest

def setup_ephemeris(args):
    print(f"Setting up ephemeris in {args.dest}...")
    # In a real impl this would download files.
    # For now we just create the dir and warn.
    os.makedirs(args.dest, exist_ok=True)
    print(f"Directory created. Please place Swiss Ephemeris files (.se1) in {args.dest}")
    print("You can download them from https://www.astro.com/ftp/swisseph/ephe/")

def validate_natal(args):
    try:
        with open(args.file, 'r') as f:
            data = json.load(f)
        profile = NatalProfile(**data)
        print("Natal Profile Validated Successfully.")
        print(f"Subject: {profile.subject_id}")
        print(f"Birth: {profile.birth_timestamp}")
    except Exception as e:
        print(f"Validation Failed: {e}")
        sys.exit(1)

def compute(args):
    # Load Natal
    try:
        with open(args.natal, 'r') as f:
            natal_data = json.load(f)
        natal_profile = NatalProfile(**natal_data)
    except Exception as e:
        print(f"Error loading natal file: {e}")
        sys.exit(1)

    # Time
    if args.time:
        try:
            timestamp = parser.parse(args.time)
            # Ensure TZ aware
            if timestamp.tzinfo is None:
                # Default to params or local
                timestamp = timestamp.astimezone() 
        except Exception as e:
            print(f"Error parsing time: {e}")
            sys.exit(1)
    else:
        timestamp = datetime.now().astimezone()

    # Location
    location = None
    if args.lat and args.lon:
        location = GeoLocation(latitude=float(args.lat), longitude=float(args.lon))
    elif args.location:
        # Simple lookup placeholder
        print(f"Location lookup for '{args.location}' not implemented yet. Using Geocentric/Default.")
        
    # Request
    req = EmotionRequest(
        subject_id=natal_profile.subject_id,
        timestamp=timestamp,
        natal_profile=natal_profile,
        current_location=location
    )

    # Engine
    ephe_path = os.environ.get("ASTRO_EPHE_PATH", args.ephe_path)
    engine = AstroEmotionEngine(ephemeris_path=ephe_path)
    
    resp = engine.compute_emotion_state(req)
    
    # Output
    print(json.dumps(resp.model_dump(), indent=2, default=str))


def main():
    parser = argparse.ArgumentParser(description="Astro Emotion Engine CLI")
    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # setup-ephemeris
    p_setup = subparsers.add_parser("setup-ephemeris")
    p_setup.add_argument("--dest", default="data/ephemeris", help="Destination folder")
    p_setup.set_defaults(func=setup_ephemeris)

    # validate-natal
    p_validate = subparsers.add_parser("validate-natal")
    p_validate.add_argument("file", help="Path to natal JSON file")
    p_validate.set_defaults(func=validate_natal)

    # compute
    p_compute = subparsers.add_parser("compute")
    p_compute.add_argument("--natal", required=True, help="Path to natal JSON file")
    p_compute.add_argument("--time", help="ISO format timestamp")
    p_compute.add_argument("--lat", help="Latitude")
    p_compute.add_argument("--lon", help="Longitude")
    p_compute.add_argument("--location", help="Location name (e.g. 'Delamar')")
    p_compute.add_argument("--ephe-path", default="data/ephemeris", help="Path to Swiss Ephemeris data")
    p_compute.set_defaults(func=compute)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)
        
    args.func(args)

if __name__ == "__main__":
    main()
