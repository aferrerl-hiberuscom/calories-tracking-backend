import dotenv from "dotenv";
import { createApp } from "./app";

dotenv.config();

const app = createApp();
const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(`Backend listening on port ${port}`);
});
