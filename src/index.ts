// Load .env BEFORE any other import so eagerly-read env vars (e.g. in
// storage.service) see the values. In CommonJS all imports are hoisted, so this
// side-effect import must be the very first line.
import "dotenv/config";
import { createApp } from "./app";

const app = createApp();
const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(`Backend listening on port ${port}`);
});
