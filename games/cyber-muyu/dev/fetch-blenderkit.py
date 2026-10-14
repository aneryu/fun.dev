"""Step 1 of the relic pipeline: download the free BlenderKit models used by dev/build-relics.py.
python3 -I dev/fetch-blenderkit.py ~/.cache/fundev-blenderkit
Free assets download without an account. Only CC0 models are used, so the processed
assets/relics.glb can live in this public repository; the .blend files are large (50-80 MB)
and stay out of it.
"""
import json, os, sys, urllib.request, uuid

# relic id: BlenderKit asset id (name, license, author at the time of download)
SOURCES = {
    "censer": "90307787-8a7a-4bc8-80ee-065049aab804",  # Chinese Tripod Censer, CC0, Free poly
    "lotus": "64ba6db4-1d29-4bd3-b03b-600cb46f4079",  # Chinese lotus lamp, CC0, Free poly
    "incense": "8c2c63fb-5989-4ec1-a5f7-30006c74038b",  # Incense Burner, CC0, Seatla Morake
}
API = "https://www.blenderkit.com/api/v1"

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
for name, asset in SOURCES.items():
    path = os.path.join(out, name + ".blend")
    if os.path.exists(path):
        continue
    meta = json.load(urllib.request.urlopen(f"{API}/assets/{asset}/"))
    blend = next(f for f in meta["files"] if f["fileType"] == "blend")
    # The download endpoint answers with a signed file URL for this "scene".
    signed = json.load(urllib.request.urlopen(f"{blend['downloadUrl']}?scene_uuid={uuid.uuid4()}"))["filePath"]
    data = urllib.request.urlopen(urllib.request.Request(signed, headers={"User-Agent": "Mozilla/5.0"})).read()
    with open(path, "wb") as file:
        file.write(data)
    print(f"{name}: {meta['name']} ({meta['license']}), {len(data) // 1024} KB")
