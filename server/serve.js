const path = require("path");
const express = require("express");
const helmet = require("helmet");

const app = express();
app.disable("x-powered-by");

const distDir = path.join(__dirname, "..", "dist");

// Secure-by-default static hosting for the browser build.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'", "https://vibej.am"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "blob:"],
        "connect-src": ["'self'", "ws:", "wss:", "https://api.ipify.org"],
        "font-src": ["'self'", "data:"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "frame-ancestors": ["'none'"]
      }
    }
  })
);

app.use(
  express.static(distDir, {
    // Avoid directory listing.
    extensions: ["html"],
    index: false
  })
);

app.get("*", (req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

const port = Number(process.env.PORT || 4173);
app.listen(port, () => {
  console.log(`[WebRTS] Server running: http://localhost:${port}`);
});

