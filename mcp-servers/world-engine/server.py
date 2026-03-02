import sys

# === CRITICAL: Redirect stdout to stderr BEFORE any imports ===
_real_stdout = sys.stdout
sys.stdout = sys.stderr

from mcp.server.fastmcp import FastMCP
import os
import ast
import re
from pathlib import Path
from typing import Dict, List, Set, Any

mcp = FastMCP("Tala World Engine")

class FileAnalyzer:
    @staticmethod
    def get_python_imports(file_path: str) -> List[str]:
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                tree = ast.parse(f.read())
            
            imports = []
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        imports.append(alias.name)
                elif isinstance(node, ast.ImportFrom):
                    imports.append(node.module or "")
            return sorted(list(set(imports)))
        except:
            return []

    @staticmethod
    def get_typescript_imports(file_path: str) -> List[str]:
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read()
            
            # Simple regex for TS imports
            matches = re.findall(r"from\s+['\"](.+?)['\"]", content)
            return sorted(list(set(matches)))
        except:
            return []

    @staticmethod
    def summarize_py(file_path: str) -> Dict[str, Any]:
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                tree = ast.parse(f.read())
            
            summary = {
                "classes": [],
                "functions": [],
                "imports": []
            }

            for node in ast.walk(tree):
                if isinstance(node, ast.ClassDef):
                    summary["classes"].append({
                        "name": node.name,
                        "line": node.lineno,
                        "methods": [n.name for n in node.body if isinstance(n, ast.FunctionDef)]
                    })
                elif isinstance(node, ast.FunctionDef) and not isinstance(node.parent if hasattr(node, 'parent') else None, ast.ClassDef):
                    summary["functions"].append({"name": node.name, "line": node.lineno})
                elif isinstance(node, (ast.Import, ast.ImportFrom)):
                    # already handled in common imports
                    pass
            
            return summary
        except Exception as e:
            return {"error": str(e)}

    @staticmethod
    def summarize_ts(file_path: str) -> Dict[str, Any]:
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read()
            
            # Heuristic Regex for TS classes and functions
            classes = re.findall(r"class\s+(\w+)", content)
            functions = re.findall(r"(?:export\s+)?(?:async\s+)?function\s+(\w+)", content)
            methods = re.findall(r"public\s+(?:async\s+)?(\w+)\(", content)
            
            return {
                "classes": classes,
                "functions": functions,
                "public_methods": list(set(methods))
            }
        except Exception as e:
            return {"error": str(e)}

@mcp.tool()
def analyze_structure(target_path: str) -> Dict[str, Any]:
    """
    Performs a structural analysis of a file (AST-based for Python, regex for TS/JS).
    Provides classes, functions, and public interfaces.
    """
    if not os.path.exists(target_path):
        return {"error": "Path not found"}

    ext = Path(target_path).suffix
    if ext == ".py":
        return FileAnalyzer.summarize_py(target_path)
    elif ext in [".ts", ".tsx", ".js", ".jsx"]:
        return FileAnalyzer.summarize_ts(target_path)
    else:
        return {"error": f"Unsupported extension: {ext}"}

@mcp.tool()
def get_dependencies(target_path: str, workspace_root: str) -> Dict[str, Any]:
    """
    Finds identifying imports in a file and attempts to resolve them within the workspace.
    """
    if not os.path.exists(target_path):
        return {"error": "Path not found"}

    ext = Path(target_path).suffix
    imports = []
    if ext == ".py":
        imports = FileAnalyzer.get_python_imports(target_path)
    elif ext in [".ts", ".tsx", ".js", ".jsx"]:
        imports = FileAnalyzer.get_typescript_imports(target_path)

    # Resolution logic
    resolved = []
    external = []
    
    for imp in imports:
        # Check relative or workspace-absolute paths
        # This is a basic resolver
        is_internal = False
        parts = imp.split('/')
        if imp.startswith('.'):
             is_internal = True
        elif os.path.exists(os.path.join(workspace_root, parts[0])):
             is_internal = True
        
        if is_internal:
            resolved.append(imp)
        else:
            external.append(imp)

    return {
        "file": os.path.basename(target_path),
        "internal_deps": resolved,
        "external_deps": external
    }

@mcp.tool()
def workspace_overview(workspace_root: str, max_depth: int = 2) -> Dict[str, Any]:
    """
    Scans the workspace to build a high-level map of components.
    """
    overview = {}
    skip_dirs = {'.git', 'node_modules', 'dist', 'dist-electron', 'bin', 'data', 'venv', '__pycache__'}

    for root, dirs, files in os.walk(workspace_root):
        rel_path = os.path.relpath(root, workspace_root)
        if any(part in skip_dirs for part in rel_path.split(os.sep)):
            continue
        
        depth = rel_path.count(os.sep)
        if depth > max_depth:
            continue

        if rel_path == '.':
            rel_path = 'root'
            
        overview[rel_path] = {
            "dirs": [d for d in dirs if d not in skip_dirs],
            "files": [f for f in files if f.endswith(('.ts', '.tsx', '.js', '.py', '.md'))]
        }
    
    return overview

if __name__ == "__main__":
    sys.stdout = _real_stdout  # restore for MCP protocol transport
    mcp.run(transport='stdio')
