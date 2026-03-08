import os
import re

dir_path = r"d:\src\client1\tala-app\memory\processed\roleplay_md"
files = [f for f in os.listdir(dir_path) if f.endswith('.md')]

print(f"Forcing unique IDs for {len(files)} files...")

fixed_count = 0
for filename in files:
    file_path = os.path.join(dir_path, filename)
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    new_id = filename.replace('.md', '')
    
    # Force replace the 'id:' line in YAML frontmatter
    # Matches 'id: ' followed by anything until the end of the line
    new_content = re.sub(r'^id:\s+.*$', f'id: {new_id}', content, flags=re.MULTILINE)
    
    if new_content != content:
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(new_content)
        fixed_count += 1
    else:
        # If regex didn't match (e.g. no id line), we add it? 
        # But we saw they all have it. Let's just log if they don't.
        if "id:" not in content:
            print(f"WARNING: No id line found in {filename}")

print(f"Forced {fixed_count} unique IDs.")
