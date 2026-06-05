const jwt = require("jsonwebtoken");
const { createApp } = require("../dist/app");

function percentile(values, p) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[index];
}

async function run() {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "change-me";
  process.env.REDIS_URL = "";

  const app = createApp();
  const token = jwt.sign({ sub: "perf-user" }, process.env.JWT_SECRET);

  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to resolve benchmark server port");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  const samples = [];

  for (let i = 0; i < 20; i += 1) {
    const start = Date.now();
    const response = await fetch(`${baseUrl}/api/v1/analyze-image`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ imageBase64: "", mimeType: "image/jpeg" }),
    });
    const latency = Date.now() - start;

    if (response.status !== 400 && response.status !== 429) {
      throw new Error(`Unexpected status during benchmark: ${response.status}`);
    }

    samples.push(latency);
  }

  server.close();

  const p95 = percentile(samples, 95);
  const avg = Math.round(
    samples.reduce((acc, n) => acc + n, 0) / samples.length,
  );

  console.log(
    JSON.stringify({
      scenario: "analyze-image validation path",
      requests: samples.length,
      avg_ms: avg,
      p95_ms: p95,
    }),
  );
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
