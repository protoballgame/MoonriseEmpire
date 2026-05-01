const { app, BrowserWindow } = require("electron");
const path = require("path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: "#05060a",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, "preload.js")
    }
  });

  win.webContents.on("will-navigate", (event) => {
    // Prevent navigation to arbitrary external URLs (defense-in-depth).
    event.preventDefault();
  });

  win.webContents.setWindowOpenHandler(() => {
    return { action: "deny" };
  });

  const indexHtmlPath = path.join(app.getAppPath(), "dist", "index.html");
  win.loadFile(indexHtmlPath);
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

