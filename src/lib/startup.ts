/** Classify startup failures without printing driver messages, URIs, credentials or stacks. */
export class StartupError extends Error {
 constructor(public code:string, message:string){super(message);}
}
export function startupConfig(env:NodeJS.ProcessEnv){
 if(!env.MONGODB_URI?.trim())throw new StartupError('MISSING_MONGODB_URI','Set MONGODB_URI to your MongoDB Atlas connection string in Render Environment.');
 if(!/^mongodb(?:\+srv)?:\/\//.test(env.MONGODB_URI))throw new StartupError('INVALID_MONGODB_URI','MONGODB_URI must begin with mongodb:// or mongodb+srv://. Use the Atlas Drivers connection string.');
 if((env.JWT_SECRET?.length??0)<32)throw new StartupError('INVALID_JWT_SECRET','Set JWT_SECRET to a random value of at least 32 characters.');
 const port=Number(env.PORT??4000);
 if(!Number.isInteger(port)||port<0||port>65535)throw new StartupError('INVALID_PORT','PORT must be a valid numeric port. On Render, use its automatically supplied PORT.');
 if(env.RENDER==='true'){
  if(/(?:^|[\/@,])(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/? ,]|$)/i.test(env.MONGODB_URI))throw new StartupError('LOCAL_DATABASE_ON_RENDER','Render cannot reach MongoDB running on your PC using localhost or 127.0.0.1. Configure the Atlas URI.');
  if(env.HOST&&env.HOST!=='0.0.0.0')throw new StartupError('INVALID_RENDER_HOST','Remove HOST from Render Environment or set HOST=0.0.0.0. A loopback host is not publicly reachable.');
 }
 return {uri:env.MONGODB_URI,port,host:env.HOST??'0.0.0.0'};
}
export function safeStartupFailure(error:unknown,stage:string){
 if(error instanceof StartupError)return `[Startup] ${error.code}: ${error.message}`;
 const e=error as {code?:unknown;name?:unknown;message?:unknown};
 // Inspect text only to choose a static hint. Never return the text itself.
 const message=typeof e?.message==='string'?e.message:'';
 if(e?.code===18||e?.code===8000||/authentication failed|bad auth/i.test(message))return '[Startup] MONGODB_AUTH_FAILED: Check the Atlas DATABASE user/password (not your Atlas website login), authSource, and percent-encoding of password characters.';
 if(e?.code===13)return '[Startup] MONGODB_PERMISSION_DENIED: The database user needs read/write and index-creation permissions on the configured tracker database.';
 if(e?.name==='MongoParseError'||e?.name==='MongoInvalidArgumentError')return '[Startup] INVALID_MONGODB_URI: Copy the Atlas Drivers URI, replace placeholders, percent-encode password characters, and remove wrapping quotes/whitespace.';
 if(/certificate|TLS|SSL/i.test(message))return '[Startup] MONGODB_TLS_FAILED: Check MongoDB TLS/certificate trust and connection settings. Do not disable certificate validation.';
 if(e?.name==='MongooseServerSelectionError'||e?.name==='MongoServerSelectionError'||['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ETIMEDOUT'].includes(String(e?.code)))return '[Startup] MONGODB_UNREACHABLE: Check that the Atlas cluster is running, the URI/DNS is correct, and Atlas Network Access permits the Render service outbound IP ranges.';
 if(e?.code==='EADDRINUSE'||e?.code==='EACCES')return '[Startup] HTTP_BIND_FAILED: Check PORT and HOST; Render requires 0.0.0.0 and its supplied PORT.';
 if(e?.code===11000)return '[Startup] INDEX_CONFLICT: Existing data conflicts with a required unique index. Inspect the database indexes/duplicates without deleting usage or checkpoints.';
 return `[Startup] FAILED during ${stage}. Check configuration and database availability. Raw error details were withheld to protect credentials.`;
}
