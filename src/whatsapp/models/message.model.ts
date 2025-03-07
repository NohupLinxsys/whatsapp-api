import { Schema } from 'mongoose';
import { dbserver } from '../../db/db.connect';
import { wa } from '../types/wa.types';

class Key {
  id?: string;
  remoteJid?: string;
  fromMe?: boolean;
  participant?: string;
}

export class MessageRaw {
  _id?: string;
  key?: Key;
  pushName?: string;
  message?: object;
  messageTimestamp?: number | Long.Long;
  owner: string;
  source?: 'android' | 'web' | 'ios';
}

const messageSchema = new Schema<MessageRaw>({
  key: {
    id: { type: String, required: true, minlength: 1 },
    remoteJid: { type: String, required: true, minlength: 1 },
    fromMe: { type: Boolean, required: true },
    participant: { type: String, minlength: 1 },
  },
  pushName: { type: String },
  message: { type: Object },
  source: { type: String, minlength: 3, enum: ['android', 'web', 'ios'] },
  messageTimestamp: { type: Number, required: true },
  owner: { type: String, required: true, minlength: 1 },
});

export const MessageModel = dbserver?.model(MessageRaw.name, messageSchema, 'messages');
export type IMessageModel = typeof MessageModel;

export class MessageUpdateRaw {
  _id?: string;
  remoteJid?: string;
  id?: string;
  fromMe?: boolean;
  participant?: string;
  datetime?: number;
  status?: wa.StatusMessage;
  owner: string;
}

const messageUpdateSchema = new Schema({
  remoteJid: { type: String, required: true, min: 1 },
  id: { type: String, required: true, min: 1 },
  fromMe: { type: Boolean, required: true },
  participante: { type: String, min: 1 },
  datetime: { type: Number, required: true, min: 1 },
  status: { type: String, required: true },
  owner: { type: String, required: true, min: 1 },
});

export const MessageUpModel = dbserver?.model(
  MessageUpdateRaw.name,
  messageUpdateSchema,
  'messageUpdate',
);
export type IMessageUpModel = typeof MessageUpModel;
