// Consistent application-data backup + disposable local restoration proof. Source is read-only.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const { MongoClient } = require("mongodb"),
  { EJSON } = require("bson");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const root = path.resolve(__dirname, "../.local/production-backups");
const stable = (x) =>
  Array.isArray(x)
    ? x.map(stable)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, stable(x[k])]),
        )
      : x;
const canonical = (x) =>
  JSON.stringify(stable(EJSON.serialize(x, { relaxed: false })));
const digest = (rows) =>
  crypto
    .createHash("sha256")
    .update(rows.map(canonical).join("\n"))
    .digest("hex");
let stage = 'initialization';
async function backupRestore(sourceUri, restoreUri) {
  const local = new URL(restoreUri);
  assert.equal(local.protocol, "mongodb:");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(local.hostname));
  assert.match(local.pathname, /^\/tracker_restore_test_[0-9]+$/);
  const source = new MongoClient(sourceUri, {
      serverSelectionTimeoutMS: 10000,
    }),
    target = new MongoClient(restoreUri, { serverSelectionTimeoutMS: 5000 });
  let restoreCreated = false;
  try {
    stage = 'source connection'; await source.connect();
    stage = 'local restore connection'; await target.connect();
    const from = source.db(),
      to = target.db();
    assert.equal((await to.listCollections().toArray()).length, 0);
    stage = 'collection inventory'; const info = await from.listCollections().toArray();
    assert.ok(
      info.every((c) => c.type === "collection" || c.name === "usagepoints"),
      "Unexpected non-collection",
    );
    const names = info
      .filter((c) => c.type === "collection")
      .map((c) => c.name)
      .sort();
    const allowed = [
      "admins",
      "checkpoints",
      "devices",
      "people",
      "promptturns",
      "sessionprojects",
      "prompterasures",
      "usagerecords",
      "usagebuckets",
      "storageRollout",
    ];
    assert.ok(
      names.every((n) => allowed.includes(n)),
      "Unknown application collection; review backup scope",
    );
    const indexes = {};
    for (const name of names)
      indexes[name] = await from.collection(name).indexes();
    stage = 'consistent snapshot'; let records;
    const session = source.startSession();
    try {
      await session.withTransaction(
        async () => {
          records = {};
          for (const name of names)
            records[name] = await from
              .collection(name)
              .find({}, { session })
              .sort({ _id: 1 })
              .toArray();
        },
        {
          readConcern: { level: "snapshot" },
          writeConcern: { w: "majority" },
          maxCommitTimeMS: 10000,
        },
      );
    } finally {
      await session.endSession();
    }
    stage = 'private snapshot file'; const folder = path.join(root, String(Date.now()));
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const backup = {
      version: 1,
      at: new Date(),
      collections: records,
      indexes,
      note: "Private consistent application snapshot. Does not include cluster users/roles/settings.",
    };
    fs.writeFileSync(
      path.join(folder, "snapshot.ejson"),
      EJSON.stringify(backup, { relaxed: false }),
      { mode: 0o600, flag: "wx" },
    );
    const loaded = EJSON.parse(
      fs.readFileSync(path.join(folder, "snapshot.ejson"), "utf8"),
      { relaxed: false },
    );
    const proof = {
      snapshotAt: backup.at,
      sourceWrites: 0,
      restoreVerified: false,
      collections: {},
    };
    for (const name of names) {
      stage = 'restore ' + name;
      restoreCreated = true;
      await to.createCollection(name);
      if (loaded.collections[name].length)
        await to.collection(name).insertMany(loaded.collections[name]);
      // Expiry is deferred for restoration parity; expected expiry indexes stay in the private manifest.
      for (const ix of loaded.indexes[name].filter(
        (i) => i.name !== "_id_" && i.expireAfterSeconds === undefined,
      )) {
        const {
          key,
          name: idxName,
          unique,
          sparse,
          partialFilterExpression,
          collation,
        } = ix;
        const restoredKey = Object.fromEntries(Object.entries(key).flatMap(([field,value])=>
          field==='_fts'?Object.keys(ix.weights||{}).map(k=>[k,'text']):field==='_ftsx'?[]:[[field,typeof value==='object'?Number(value):value]]));
        await to
          .collection(name)
          .createIndex(restoredKey, {
            name: idxName,
            ...(unique ? { unique } : {}),
            ...(sparse ? { sparse } : {}),
            ...(partialFilterExpression ? { partialFilterExpression } : {}),
            ...(collation ? { collation } : {}),
            ...(ix.weights?{weights:Object.fromEntries(Object.entries(ix.weights).map(([k,v])=>[k,Number(v)])),default_language:ix.default_language,language_override:ix.language_override}:{}),
          });
      }
      const actual = await to
        .collection(name)
        .find()
        .sort({ _id: 1 })
        .toArray();
      assert.equal(
        digest(actual),
        digest(records[name]),
        "Restored document parity failed",
      );
      proof.collections[name] = {
        count: actual.length,
        sha256: digest(actual),
      };
    }
    proof.restoreVerified = true;
    fs.writeFileSync(
      path.join(folder, "restore-proof.json"),
      JSON.stringify(proof, null, 2),
    );
    return {
      backupFolder: folder,
      sourceWrites: 0,
      restoreVerified: true,
      counts: Object.fromEntries(
        Object.entries(proof.collections).map(([n, p]) => [n, p.count]),
      ),
    };
  } finally {
    if (restoreCreated) {
      assert.match(target.db().databaseName, /^tracker_restore_test_[0-9]+$/);
      await target.db().dropDatabase();
    }
    await source.close();
    await target.close();
  }
}
module.exports = { backupRestore };
if (require.main === module)
  backupRestore(
    process.env.MONGODB_URI,
    "mongodb://127.0.0.1:27182/tracker_restore_test_" +
      Date.now() +
      "?replicaSet=trackerLocal",
  )
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(JSON.stringify({error:'Backup/restoration proof failed',stage,type:e.name,code:typeof e.code==='number'?e.code:null,sourceWrites:0}));
      process.exitCode = 1;
    });
