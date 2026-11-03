import { spawn } from 'child_process';
import { startupConfig, safeStartupFailure } from '../src/lib/startup';
const base={MONGODB_URI:'mongodb://127.0.0.1:27017/test?replicaSet=rs0',JWT_SECRET:'isolated-startup-test-secret-32-characters'};
test('validates required configuration and rejects local-only Render settings',()=>{
 expect(()=>startupConfig({...base,MONGODB_URI:''})).toThrow('MONGODB_URI');
 expect(()=>startupConfig({...base,JWT_SECRET:'short'})).toThrow('JWT_SECRET');
 expect(()=>startupConfig({...base,PORT:'abc'})).toThrow('PORT');
 expect(()=>startupConfig({...base,RENDER:'true'})).toThrow('Render cannot reach');
 expect(()=>startupConfig({...base,MONGODB_URI:'mongodb+srv://user:password@example.invalid/test',RENDER:'true',HOST:'127.0.0.1'})).toThrow('HOST');
 expect(startupConfig({...base,PORT:'0',HOST:'127.0.0.1'}).port).toBe(0);
});
test('diagnostics classify failures without exposing raw driver secrets',()=>{
 const secret='PRIVATE_PASSWORD_SENTINEL';
 for(const [error,expected] of [[{code:18,message:secret},'MONGODB_AUTH_FAILED'],[{code:13,message:secret},'MONGODB_PERMISSION_DENIED'],[{name:'MongoParseError',message:secret},'INVALID_MONGODB_URI'],[{name:'MongooseServerSelectionError',message:secret},'MONGODB_UNREACHABLE'],[{code:'EADDRINUSE',message:secret},'HTTP_BIND_FAILED'],[{message:secret},'FAILED during'] ] as const){
  const output=safeStartupFailure(error,'test stage');expect(output).toContain(expected);expect(output).not.toContain(secret);
 }
});
test('compiled process explains startup configuration failures without printing values',async()=>{
 const result=await new Promise<{code:number|null;output:string}>((resolve,reject)=>{
  const child=spawn(process.execPath,['dist/index.js'],{cwd:process.cwd(),env:{...process.env,MONGODB_URI:'',JWT_SECRET:'PRIVATE_INVALID_SECRET'},stdio:['ignore','pipe','pipe']});let output='';
  child.stdout.on('data',b=>output+=String(b));child.stderr.on('data',b=>output+=String(b));child.on('error',reject);child.on('exit',code=>resolve({code,output}));
 });expect(result.code).toBe(1);expect(result.output).toContain('MISSING_MONGODB_URI');expect(result.output).not.toContain('PRIVATE_INVALID_SECRET');
});
