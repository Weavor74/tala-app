# pgvector Windows Bundle Directory

This directory holds prebuilt pgvector extension files for Windows PostgreSQL installations.
The Tala bootstrap script (`bootstrap.ps1`) searches here automatically during setup.

## Why this exists

Tala's memory store requires the `pgvector` PostgreSQL extension. On Windows, compiling
pgvector from source requires Visual Studio and C++ build tools. To avoid that requirement,
Tala's bootstrap can install a prebuilt bundle from this directory — no compiler needed.

## How to add a bundle

Download a prebuilt pgvector Windows release from:

```
https://github.com/pgvector/pgvector/releases
```

Look for a release asset named something like `pgvector-pg16-windows-x64.zip` (the exact
name varies by release and PostgreSQL version).

Place the files in one of the following layouts:

### Option A — Version-specific directory (preferred)

```
installers/pgvector/windows/postgres-16/
    vector.dll
    vector.control
    vector--0.8.0.sql
    vector--0.7.0--0.8.0.sql
    ...
```

Tala searches `postgres-<major>/` first, where `<major>` matches your installed
PostgreSQL major version (e.g., `16`).

### Option B — Version-agnostic directory

```
installers/pgvector/windows/
    vector.dll
    vector.control
    vector--*.sql
```

Tala falls back to this directory if no version-specific one is found.

### Option C — Zip archive

Place a `.zip` file here:

```
installers/pgvector/windows/pgvector-pg16-x64.zip   # version-specific
installers/pgvector/windows/pgvector-windows.zip     # fallback
```

Tala will extract it automatically.

## Required files

Every bundle must contain these files:

| File              | Destination in PostgreSQL   | Purpose                       |
|-------------------|-----------------------------|-------------------------------|
| `vector.dll`      | `<pg_root>\lib\`            | Extension shared library      |
| `vector.control`  | `<pg_root>\share\extension\`| Extension metadata            |
| `vector--*.sql`   | `<pg_root>\share\extension\`| Extension SQL (one or more)   |

## Environment variable overrides

You can skip this directory entirely by setting an environment variable before running bootstrap:

```powershell
# Point to an extracted directory
$env:TALA_PGVECTOR_PATH = "C:\path\to\extracted-pgvector\"

# Point to a zip archive
$env:TALA_PGVECTOR_PATH = "C:\path\to\pgvector-bundle.zip"

# Provide a direct download URL
$env:TALA_PGVECTOR_DOWNLOAD_URL = "https://example.com/pgvector-pg16-x64.zip"
```

## Compatibility

Match the pgvector bundle to your **PostgreSQL major version** (e.g., PG 16 bundle for
a PostgreSQL 16 installation). The bootstrap script detects your installed version and
selects the matching directory automatically.

## Troubleshooting

If the extension still fails after placing a bundle:

1. Ensure the bundle files match your PostgreSQL major version.
2. Try running bootstrap as Administrator (file copy to `Program Files\PostgreSQL\`
   requires elevated permissions).
3. If the service needs to reload the library, restart the PostgreSQL service:
   ```powershell
   Restart-Service postgresql*
   ```
   Then re-run `.\bootstrap.ps1`.
4. Alternatively, use the Docker stack which includes pgvector pre-installed:
   ```
   npm run memory:up
   ```
