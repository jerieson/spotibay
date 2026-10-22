import { createApp } from './app.js';
import { env } from './env.js';

createApp().listen(env.PORT, () => {
  console.log(`api listening on :${env.PORT}`);
});
