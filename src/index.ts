import 'dotenv/config';
import { PromptTurn, SessionProject, PromptErasure } from './models/history.js';
import { historyRetentionDays } from './lib/history.js';
import mongoose from 'mongoose';
import { app } from './app.js';
import { Admin, Checkpoint, Device, Person, UsageRecord } from './models/index.js';
import { safeStartupFailure, startupConfig, StartupError } from './lib/startup.js';
let stage='configuration validation';
async function start() {
  const config=startupConfig(process.env);
  historyRetentionDays();
  stage='MongoDB connection';console.log('[Startup] Connecting to MongoDB (connection string withheld)');
  await mongoose.connect(config.uri, { serverSelectionTimeoutMS: 10000, socketTimeoutMS: 30000 });
  stage='replica-set verification';console.log('[Startup] MongoDB connected; checking transaction support');
  const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') throw new StartupError('REPLICA_SET_REQUIRED','MongoDB must be a replica set or sharded cluster. Use Atlas or configure a local replica set.');
  stage='index initialization';console.log('[Startup] Initializing required database indexes');
  await Promise.all([Admin.init(), Checkpoint.init(), Device.init(), Person.init(), UsageRecord.init(), PromptTurn.init(), SessionProject.init(), PromptErasure.init()]);
  stage='HTTP port binding';
  const server = app.listen(config.port, config.host, () => console.log('[Server] Ready ' + (server.address() as {port:number}).port));
  server.on('error',error=>{console.error(safeStartupFailure(error,stage));process.exit(1);});
}
start().catch(error => { console.error(safeStartupFailure(error,stage)); process.exit(1); });
