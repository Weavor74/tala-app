TALA APP - USB SETUP GUIDE
==========================

To run this project on a new machine (e.g., from a USB drive), follow these steps to ensure all dependencies are correctly installed.

1. PREREQUISITES
----------------
The target machine must have:
- Python 3.10 or newer (Allow "Add to PATH" during installation)
- Node.js (LTS version) if you plan to run the development version

2. COPYING TO USB
-----------------
Copy the **CONTENTS** of the `tala-app` folder to your USB drive. 
- You can place them inside a folder (e.g., `E:\tala-app\`) OR at the root of the drive (`E:\`).
- Just ensure all files and folders are kept together relative to each other.
- **IMPORTANT:** If `npm install` fails at the root (E:\), move the files into a subfolder (e.g., `E:\tala-app\`) and try again.

EXCLUDE the following large/generated folders to save space and avoid path errors:
- node_modules/       (Dependencies - will be restored)
- dist/               (Build artifacts - will be rebuilt)
- .git/               (Version history - optional)
- local-inference/venv/ (Python environment - broken if moved)
- mcp-servers/tala-core/venv/
- mcp-servers/mem0-core/venv/
- mcp-servers/astro-engine/venv/

3. SETUP ON NEW MACHINE
-----------------------
**RUN THESE STEPS ONLY ONCE PER MACHINE (OR IF YOU MOVE THE FOLDER TO A NEW PATH):**
1. Plug in the USB drive.
2. Open the project folder.
3. run `npm install` to restore Node.js dependencies.
4. Double-click `scripts\setup_usb.bat`.
   - I have updated this script to automatically find the project root.
   - It will rebuild all necessary Python environments.
   - NOTE: Internet access is required for this step to download libraries.
   - **FUTURE LAUNCHES:** Skip straight to Section 4. 

4. LAUNCHING
------------
Once setup is complete:
- Double-click `start_local_inference.bat` to start the AI Brain.
- Run `npm run dev` to start the App Interface.
