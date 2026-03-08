const { app, ipcMain, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
    const win = new BrowserWindow({
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    win.loadURL('data:text/html,<html><body><script>const {ipcRenderer} = require("electron"); ipcRenderer.send("chat-message", {text: "Hello"});</script></body></html>');

    ipcMain.on('chat-message', (event, arg) => {
        console.log("RECEIVED CHAT MESSAGE:", arg);
        app.quit();
    });
});
