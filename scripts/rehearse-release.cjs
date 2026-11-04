// Fresh local anonymized copy of the private backup; never connects to Atlas.
process.env.STORAGE_MODE='mirror';process.env.JWT_SECRET='release-rehearsal-local-secret-0000000000000000000';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const mongoose=require('mongoose'),request=require('supertest'),jwt=require('jsonwebtoken'),{EJSON}=require('bson');
const {app}=require('../dist/app'),models=require('../dist/models'),storage=require('../dist/lib/storage'),rollout=require('../dist/scripts/storage-rollout');
const dir=path.resolve(__dirname,'../.local'),backups=path.join(dir,'production-backups');
const latest=fs.readdirSync(backups).filter(n=>/^\d+$/.test(n)&&fs.existsSync(path.join(backups,n,'restore-proof.json'))).sort().pop();assert.ok(latest,'Verified backup required');
const snapshot=EJSON.parse(fs.readFileSync(path.join(backups,latest,'snapshot.ejson'),'utf8'),{relaxed:true});
const dbName='tracker_release_test_'+Date.now(),uri='mongodb://127.0.0.1:27182/'+dbName+'?replicaSet=trackerLocal';
const normalize=x=>{if(typeof x==='number'&&!Number.isInteger(x))return Math.round(x*1e9)/1e9;if(Array.isArray(x))return x.map(normalize).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));if(x&&typeof x==='object')return Object.fromEntries(Object.keys(x).filter(k=>k!=='generatedAt').sort().map(k=>[k,normalize(x[k])]));return x;};
let server;
(async()=>{try{await mongoose.connect(uri);await Promise.all(Object.values(models).filter(m=>m?.modelName).map(m=>m.init()));await storage.initStorage();
 for(const name of ['people','devices','checkpoints','usagerecords']){let rows=snapshot.collections[name];
  if(name==='people')rows=rows.map((r,i)=>({...r,name:'Demo person '+(i+1),notes:''}));
  if(name==='devices')rows=rows.map((r,i)=>({...r,name:'Demo device '+(i+1),notes:'',keyHash:'not-a-valid-test-ingestion-key',keyPrefix:'fixture',promptCollectionEnabled:false}));
  if(rows.length)await mongoose.connection.db.collection(name).insertMany(rows);
 }
 const admin=await models.Admin.create({username:'rehearsal',passwordHash:'not-a-login-password'}),cookie='admin_token='+jwt.sign({sub:String(admin._id),role:'admin'},process.env.JWT_SECRET,{expiresIn:'10m'});
 await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});
 const first=snapshot.collections.usagerecords[0],filters=[{}, {timezone:'UTC'}, {timezone:'America/New_York'}, {personId:String(first.personIdAtTime)}, {deviceId:String(first.deviceId)}, {model:first.usageModel}, {from:'2026-11-04',to:'2026-11-04'}];
 async function capture(){const results=[],latency=[];for(const f of filters)for(const endpoint of ['overview','sessions','export.csv']){const qs=new URLSearchParams({from:'2026-11-01',to:'2026-11-06',timezone:'Asia/Kolkata',...f});const start=performance.now(),r=await request(server).get('/api/dashboard/'+endpoint+'?'+qs).set('Cookie',cookie).set('Connection','close');assert.equal(r.status,200,endpoint);latency.push(performance.now()-start);results.push(endpoint==='export.csv'?r.text:normalize(r.body));}return {results,latency};}
 const before=await capture();const backfill=await rollout.backfillAll();const proof=await rollout.verifyStorage();
 await mongoose.connection.db.collection('storageRollout').updateOne({_id:storage.STORAGE_VERSION},{$set:{...proof,readMode:'compact'}},{upsert:true});await storage.refreshReadMode();const after=await capture();assert.deepEqual(after.results,before.results);
 await mongoose.connection.db.collection('storageRollout').updateOne({_id:storage.STORAGE_VERSION},{$set:{readMode:'raw'}});await storage.refreshReadMode();const rollback=await capture();assert.deepEqual(rollback.results,before.results);
 const median=a=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)];
 const report={passed:true,records:proof.count,totalTokens:proof.total,completedStreams:backfill.completedStreams,filterSets:filters.length,endpoints:['overview','sessions','export.csv'],fullDocumentParity:true,rawCompactRollbackOutputsEqual:true,rawMedianMs:median(before.latency),compactMedianMs:median(after.latency),compactMaxMs:Math.max(...after.latency),note:'Anonymized restored production snapshot; local bounded measurements, not production throughput proof.'};fs.writeFileSync(path.join(dir,'release-rehearsal.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 }finally{if(server)await new Promise(resolve=>server.close(resolve));if(mongoose.connection.readyState===1){assert.ok(mongoose.connection.name.startsWith('tracker_release_test_'));await mongoose.connection.dropDatabase();}await mongoose.disconnect();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
