import 'dotenv/config';
import mongoose from 'mongoose';
import { app } from './app.js';
import { Admin, Checkpoint, Device, Person, UsageRecord } from './models/index.js';
async function start() {
  if (!process.env.MONGODB_URI || (process.env.JWT_SECRET?.length ?? 0) < 32) throw new Error('Set backend MONGODB_URI and JWT_SECRET');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, socketTimeoutMS: 30000 });
  const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('MongoDB replica set required');
  await Promise.all([Admin.init(), Checkpoint.init(), Device.init(), Person.init(), UsageRecord.init()]);
  const server = app.listen(Number(process.env.PORT ?? 4000), process.env.HOST ?? '0.0.0.0', () => console.log('[Server] Ready ' + (server.address() as {port:number}).port));
}
start().catch(() => { console.error('Startup failed. Check backend configuration and MongoDB replica set availability.'); process.exit(1); });
