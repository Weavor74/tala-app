TALA APP - FULLY PORTABLE BUILD GUIDE
======================================

This build requires ZERO installation on target machines.
No Python. No Node.js. Just plug in and run.

1. PREREQUISITES (Dev Machine Only)
-----------------------------------
Download Python 3.13 Embeddable (64-bit) from:
https://www.python.org/ftp/python/3.13.3/python-3.13.3-embed-amd64.zip

Save it as: resources\python-3.13-embed-amd64.zip

2. BUILD STEPS (Run Once on Dev Machine)
-----------------------------------------
1. Run: scripts\make_portable.bat
   - This downloads pip and installs ALL Python dependencies
   - Creates bin\python-portable with everything pre-installed
   
2. Run: npm run dist
   - This creates a Windows executable with Node.js bundled
   - Includes the portable Python runtime

3. RESULT
---------
The dist\win-unpacked folder now contains:
- Tala.exe (Electron app with Node.js bundled)
- bin\python-portable\ (Python 3.13 + all libraries)
- models\ (AI model)
- memory\ (RAG database)
- mcp-servers\ (Intelligence modules)
- start_local_inference.bat (Launch script)

4. DEPLOYMENT
-------------
Copy dist\win-unpacked to USB drive (e.g., E:\Tala\)

5. USAGE (Target Machine - ZERO SETUP!)
----------------------------------------
1. Plug in USB
2. Navigate to the Tala folder
3. Double-click: start_local_inference.bat (starts AI Brain)
4. Double-click: Tala.exe (starts App)

Done! Everything works immediately.

6. SIZE WARNING
---------------
Total size: ~2-3GB (includes full Python runtime + AI model)
If space is limited, you can delete models\ and download smaller ones.

7. PORTABILITY SCOPE
--------------------
- Windows only (binaries are platform-specific)
- Works on Windows 10/11 (64-bit)
- No admin rights needed
- No internet needed (after initial build)
