import os
import yaml
import re
import sys
import json
from datetime import datetime

class MemoryValidator:
    def __init__(self, memory_dir):
        self.memory_dir = memory_dir
        self.errors = []
        self.warnings = []
        self.ids = {}
        self.timeline = []

    def validate_file(self, file_path):
        rel_path = os.path.relpath(file_path, self.memory_dir)
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()

            frontmatter_match = re.match(r'^---\s*\n(.*?)\n---\s*\n', content, re.DOTALL)
            if not frontmatter_match:
                self.errors.append(f"[{rel_path}] Missing YAML frontmatter")
                return

            yaml_content = frontmatter_match.group(1)
            try:
                data = yaml.safe_load(yaml_content)
            except Exception as e:
                self.errors.append(f"[{rel_path}] YAML parse error: {e}")
                return

            if not data:
                self.errors.append(f"[{rel_path}] Empty frontmatter")
                return

            # Check required fields
            required = ['id', 'age', 'life_stage']
            for field in required:
                if field not in data:
                    self.errors.append(f"[{rel_path}] Missing required field: {field}")

            # Check ID uniqueness
            doc_id = data.get('id')
            if doc_id:
                if doc_id in self.ids:
                    self.errors.append(f"[{rel_path}] Duplicate ID: {doc_id} (also in {self.ids[doc_id]})")
                else:
                    self.ids[doc_id] = rel_path

            # Collect for timeline check
            age = data.get('age')
            if isinstance(age, (int, float)):
                self.timeline.append({
                    'path': rel_path,
                    'age': age,
                    'life_stage': data.get('life_stage')
                })

        except Exception as e:
            self.errors.append(f"[{rel_path}] Unexpected error: {e}")

    def check_timeline(self):
        # Sort by age
        self.timeline.sort(key=lambda x: x['age'])
        # Simple check: life_stage should generally progress with age
        # (This is a loose check but helps find major outliers)
        stages = ["Newborn", "Childhood", "Adolescence", "Young Adulthood", "Adulthood", "Late Adulthood"]
        last_stage_idx = -1
        
        for entry in self.timeline:
            stage = entry['life_stage']
            if stage in stages:
                idx = stages.index(stage)
                if idx < last_stage_idx:
                    self.warnings.append(f"Timeline potential inconsistency: {entry['path']} (Age {entry['age']}) is {stage}, but followed a later stage in timeline.")
                last_stage_idx = idx

    def run(self):
        print(f"Scanning {self.memory_dir}...")
        for root, dirs, files in os.walk(self.memory_dir):
            if 'archive' in root: continue
            for file in files:
                if file.endsWith('.md'):
                    self.validate_file(os.path.join(root, file))

        self.check_timeline()

        print("\n" + "="*50)
        print(f"VALIDATION RESULTS: {len(self.ids)} files scanned")
        print("="*50)

        if not self.errors and not self.warnings:
            print("âœ… All LTMF files validated successfully.")
        else:
            if self.errors:
                print(f"\nâ Œ ERRORS ({len(self.errors)}):")
                for err in self.errors: print(f"  - {err}")
            
            if self.warnings:
                print(f"\nâš ï¸ WARNINGS ({len(self.warnings)}):")
                for warn in self.warnings: print(f"  - {warn}")

        return len(self.errors) == 0

if __name__ == "__main__":
    mem_path = r"d:\src\client1\tala-app\memory"
    validator = MemoryValidator(mem_path)
    success = validator.run()
    sys.exit(0 if success else 1)
