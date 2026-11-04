import mongoose, { Schema, Types } from 'mongoose';

export interface IPromptTurn {
  _id: Types.ObjectId; deviceId: Types.ObjectId; sessionId: string; promptId: string;
  personIdAtTime: Types.ObjectId | null; promptText: string | null; promptLength: number | null;
  truncated: boolean; submittedAt: Date | null; completedAt: Date | null;
  submitFingerprint: string | null; stopFingerprint: string | null;
  expiresAt: Date; createdAt: Date;
}
const identity = { type: String, required: true, maxlength: 128, match: /^[A-Za-z0-9._:-]+$/ };
const PromptTurnSchema = new Schema<IPromptTurn>({
  deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true },
  sessionId: identity, promptId: identity,
  personIdAtTime: { type: Schema.Types.ObjectId, ref: 'Person', default: null },
  promptText: { type: String, default: null, maxlength: 32000 },
  promptLength: { type: Number, default: null, min: 0, max: 10000000 },
  truncated: { type: Boolean, default: false },
  submittedAt: { type: Date, default: null }, completedAt: { type: Date, default: null },
  submitFingerprint: { type: String, default: null }, stopFingerprint: { type: String, default: null },
  expiresAt: { type: Date, required: true }, createdAt: { type: Date, default: Date.now },
}, { versionKey: false });
PromptTurnSchema.index({ deviceId: 1, sessionId: 1, promptId: 1 }, { unique: true });
PromptTurnSchema.index({ deviceId: 1, submittedAt: -1 });
PromptTurnSchema.index({ personIdAtTime: 1, submittedAt: -1 });
PromptTurnSchema.index({ submittedAt: -1 });
PromptTurnSchema.index({ promptText: 'text' }, { default_language: 'none', name: 'prompt_history_search' });
// Only prompt history expires. Usage counters/checkpoints have no independent TTL.
PromptTurnSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const PromptTurn = mongoose.model<IPromptTurn>('PromptTurn', PromptTurnSchema);

const SessionProjectSchema = new Schema({
  deviceId: { type: Schema.Types.ObjectId, required: true, ref: 'Device' },
  sessionId: identity, project: { type: String, trim: true, maxlength: 80, default: '' },
}, { timestamps: true, versionKey: false });
SessionProjectSchema.index({ deviceId: 1, sessionId: 1 }, { unique: true });
SessionProjectSchema.index({ project: 1, deviceId: 1 });
export const SessionProject = mongoose.model('SessionProject', SessionProjectSchema);

// Opaque replay protection after a user erases a prompt. No text or person ID retained.
const PromptErasureSchema = new Schema({
  deviceId: { type: Schema.Types.ObjectId, required: true },
  identityHash: { type: String, required: true },
}, { versionKey: false });
PromptErasureSchema.index({ deviceId: 1, identityHash: 1 }, { unique: true });
export const PromptErasure = mongoose.model('PromptErasure', PromptErasureSchema);
