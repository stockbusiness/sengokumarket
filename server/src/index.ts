import dotenv from 'dotenv';
dotenv.config();

import { createApp } from './app';

const port = process.env.PORT ? Number(process.env.PORT) : 4000;
const app = createApp();

app.listen(port, () => {
  console.log(`server listening on port ${port}`);
});
