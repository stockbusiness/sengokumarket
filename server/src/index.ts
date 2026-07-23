import dotenv from 'dotenv';
dotenv.config();

import { createApp } from './app';
import { assertRequiredEnv } from './shared/config/env';
import { appConfig } from './shared/config/appConfig';

assertRequiredEnv();

const port = appConfig.port;
const app = createApp();

app.listen(port, () => {
  console.log(`server listening on port ${port}`);
});
