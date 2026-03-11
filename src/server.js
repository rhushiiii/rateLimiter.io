require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const apiRoutes = require("./routes/api");
const { metricsService } = require("./middleware/rateLimiter");

const PORT = process.env.PORT || 3000;
const app = express();

app.set("trust proxy", true);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// Mount API routes
app.use("/api", apiRoutes);

app.get("/metrics", async (req, res) => {
  const body = await metricsService.prometheus();
  res.type("text/plain").send(body);
});

// Root — serve dashboard
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not Found", path: req.path });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("[Server Error]", err);
  res.status(500).json({ error: "Internal Server Error" });
});

app.listen(PORT, () => {
  console.log(`[Server] Rate Limiter running on http://localhost:${PORT}`);
  console.log(`[Server] Redis: ${process.env.REDIS_URL || "redis://localhost:6379"}`);
});

module.exports = app;
