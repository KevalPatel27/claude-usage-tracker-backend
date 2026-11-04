import mongoose, { Document, Schema, Types } from 'mongoose';

// Shared persistence invariants. Request parsing is still required: update validators
// only run for supported operators, not arbitrary raw database writes.
const safeCounter = { validator: (value: number) => Number.isSafeInteger(value) && value >= 0, message: 'Expected a nonnegative safe integer' };
const nanoString = /^\d{1,20}$/;

// ─── Person ───────────────────────────────────────────────────────────────────

export interface IPerson extends Document {
  _id: Types.ObjectId;
  name: string;
  notes: string;
  archivedAt: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const PersonSchema = new Schema<IPerson>(
  { name: { type: String, required: true, trim: true, maxlength: 120 }, notes: { type: String, default: "", maxlength: 2000 }, archivedAt: { type: Date, default: null }, revision: { type: Number, default: 0, validate: safeCounter } },
  { timestamps: true }
);

PersonSchema.index({ archivedAt: 1, name: 1 });

export const Person = mongoose.model<IPerson>('Person', PersonSchema);

// ─── Device ───────────────────────────────────────────────────────────────────

export interface IDeviceAssignment {
  personId: Types.ObjectId;
  assignedAt: Date;
  revokedAt?: Date;
}

export interface IDevice extends Document {
  _id: Types.ObjectId;
  name: string;
  notes: string;
  archivedAt: Date | null;
  revision: number;
  keyHash: string;       // bcrypt hash — never store raw key
  keyPrefix: string;     // first 8 chars for display/identification
  personId: Types.ObjectId | null;
  assignments: IDeviceAssignment[];
  revokedAt: Date | null;
  lastReportAt: Date | null;
  promptCollectionEnabled: boolean;
  lastHistoryReportAt: Date | null;
  historySetupVersion: string | null;
  historyPlatform: string | null;
  historyPendingCount: number | null;
  historyDroppedCount: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const DeviceAssignmentSchema = new Schema<IDeviceAssignment>(
  {
    personId: { type: Schema.Types.ObjectId, ref: 'Person', required: true },
    assignedAt: { type: Date, required: true },
    revokedAt: { type: Date },
  },
  { _id: false }
);

const DeviceSchema = new Schema<IDevice>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    notes: { type: String, default: "", maxlength: 2000 },
    archivedAt: { type: Date, default: null },
    revision: { type: Number, default: 0, validate: safeCounter },
    keyHash: { type: String, required: true },
    keyPrefix: { type: String, required: true, length: 8 },
    personId: { type: Schema.Types.ObjectId, ref: 'Person', default: null },
    assignments: { type: [DeviceAssignmentSchema], default: [] },
    revokedAt: { type: Date, default: null },
    lastReportAt: { type: Date, default: null },
    promptCollectionEnabled: { type: Boolean, default: false },
    lastHistoryReportAt: { type: Date, default: null },
    historySetupVersion: { type: String, default: null, maxlength: 30 },
    historyPlatform: { type: String, default: null },
    historyPendingCount: { type: Number, default: null },
    historyDroppedCount: { type: Number, default: null },
  },
  { timestamps: true }
);

DeviceSchema.index({ personId: 1 });
DeviceSchema.index({ 'assignments.personId': 1 });
DeviceSchema.index({ archivedAt: 1, createdAt: -1 });
DeviceSchema.index({ revokedAt: 1 });
// Ingestion resolves a short nonunique prefix, then verifies the complete key hash.
DeviceSchema.index({ keyPrefix: 1, revokedAt: 1, archivedAt: 1 }, { name: 'ingestion_key_lookup' });

export const Device = mongoose.model<IDevice>('Device', DeviceSchema);

// ─── Usage Record ─────────────────────────────────────────────────────────────

export interface IUsageRecord {
  _id: Types.ObjectId;
  deviceId: Types.ObjectId;
  sessionId: string | null;
  personIdAtTime: Types.ObjectId | null;  // snapshot at ingestion — never reassigned
  timeUnixNano: string;
  intervalStart: string;
  temporality: number;
  exportedAt: Date;                         // from OTLP timeUnixNano
  usageModel: string;   // stored as usageModel to avoid Mongoose Document.model naming conflict
  tokenType: string;    // input | output | cacheRead | cacheCreation
  querySource: string;
  deltaTokens: number;  // increment from previous cumulative checkpoint
  cumulativeAtExport: number;
  seriesKey: string;    // uniquely identifies a counter series
  startTimeUnixNano: string;
  createdAt: Date;
}

const UsageRecordSchema = new Schema<IUsageRecord>(
  {
    deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true, index: true },
    sessionId: { type: String, default: null, maxlength: 128 },
    personIdAtTime: { type: Schema.Types.ObjectId, ref: 'Person', default: null },
    exportedAt: { type: Date, required: true },
    timeUnixNano: { type: String, required: true, match: nanoString },
    intervalStart: { type: String, required: true, match: nanoString },
    temporality: { type: Number, required: true, enum: [1, 2] },
    usageModel: { type: String, required: true, maxlength: 200 },
    tokenType: { type: String, required: true, enum: ['input', 'output', 'cacheRead', 'cacheCreation'] },
    querySource: { type: String, required: true, default: 'main', maxlength: 200 },
    deltaTokens: { type: Number, required: true, validate: safeCounter },
    cumulativeAtExport: { type: Number, required: true, validate: safeCounter },
    seriesKey: { type: String, required: true },
    startTimeUnixNano: { type: String, required: true, match: nanoString },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// Prevent duplicate inserts from retried exports
UsageRecordSchema.index(
  { deviceId: 1, seriesKey: 1, timeUnixNano: 1 },
  { unique: true }
);
// Dashboard read patterns
UsageRecordSchema.index({ deviceId: 1, exportedAt: -1 });
UsageRecordSchema.index({ personIdAtTime: 1, exportedAt: -1 });
UsageRecordSchema.index({ exportedAt: -1 });
UsageRecordSchema.index({ usageModel: 1, exportedAt: -1 }, { name: 'usage_model_period' });
UsageRecordSchema.index({ sessionId: 1, deviceId: 1, exportedAt: -1 });

if(process.env.STORAGE_MODE==='compact-v2'){UsageRecordSchema.set('autoCreate',false);UsageRecordSchema.set('autoIndex',false);}
export const UsageRecord = mongoose.model<IUsageRecord>('UsageRecord', UsageRecordSchema,process.env.STORAGE_MODE==='compact-v2'?'usagepoints':'usagerecords');

// ─── Checkpoint ───────────────────────────────────────────────────────────────
// Tracks last known cumulative value per series to calculate deltas.
// Stored in MongoDB so restarts don't lose state.

export interface ICheckpoint extends Document {
  _id: Types.ObjectId;
  deviceId: Types.ObjectId;
  seriesKey: string;
  revision: number;
  lastCumulative: number;
  compactVersion?: string;
  purgedThroughTimeUnixNano?: string;
  purgedCumulative?: number;
  lastStartTimeUnixNano: string;  // detect counter resets (process restarts)
  updatedAt: Date;
}

const CheckpointSchema = new Schema<ICheckpoint>(
  {
    deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true },
    seriesKey: { type: String, required: true },
    revision: { type: Number, default: 0, validate: safeCounter },
    lastCumulative: { type: Number, default: 0, validate: safeCounter },
    compactVersion: { type:String },
    purgedThroughTimeUnixNano: { type: String, match: nanoString },
    purgedCumulative: { type: Number, validate: safeCounter },
    lastStartTimeUnixNano: { type: String, default: '0', match: nanoString },
    updatedAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

CheckpointSchema.index({ deviceId: 1, seriesKey: 1 }, { unique: true });

export const Checkpoint = mongoose.model<ICheckpoint>('Checkpoint', CheckpointSchema);

// ─── Admin ────────────────────────────────────────────────────────────────────

export interface IAdmin extends Document {
  _id: Types.ObjectId;
  username: string;
  passwordHash: string;
  createdAt: Date;
}

const AdminSchema = new Schema<IAdmin>(
  {
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true }
);

export const Admin = mongoose.model<IAdmin>('Admin', AdminSchema);
