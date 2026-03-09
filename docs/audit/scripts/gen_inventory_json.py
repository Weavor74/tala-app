import json
import os

root_dir = r"d:\src\client1\tala-app"
temp_file_list = os.path.join(root_dir, "docs", "audit", "temp_file_list_utf8.txt")
output_json = os.path.join(root_dir, "docs", "audit", "repo_inventory.json")

inventory = {
    "root": root_dir,
    "files": []
}

try:
    with open(temp_file_list, "r", encoding="utf-8-sig") as f:
        for line in f:
            path = line.strip()
            if not path: continue
            
            try:
                stats = os.stat(path)
                rel_path = os.path.relpath(path, root_dir)
                inventory["files"].append({
                    "path": rel_path,
                    "size": stats.st_size,
                    "modified": stats.st_mtime,
                    "is_dir": os.path.isdir(path)
                })
            except Exception:
                # Handle cases where file might be deleted or inaccessible during scan
                continue

    with open(output_json, "w", encoding="utf-8") as f:
        json.dump(inventory, f, indent=2)
    print(f"Inventory saved to {output_json}")

except Exception as e:
    print(f"Error: {e}")
