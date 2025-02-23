import makeWASocket, {
  BaileysEventEmitter,
  delay,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  generateWAMessageFromContent,
  getDevice,
  isJidGroup,
  isJidUser,
  MessageRetryMap,
  prepareWAMessageMedia,
  proto,
  useMultiFileAuthState,
  UserFacingSocketConfig,
  WABrowserDescription,
  WAMediaUpload,
  WASocket,
} from '@adiwajshing/baileys';
import {
  ConfigService,
  ConfigSessionPhone,
  Database,
  StoreConf,
  Webhook,
} from '../../config/env.config';
import { Logger } from '../../config/logger.config';
import { INSTANCE_DIR, ROOT_DIR } from '../../config/path.config';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import axios from 'axios';
import { v4 } from 'uuid';
import qrcode, { QRCodeToDataURLOptions } from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import { Events, wa } from '../types/wa.types';
import { Boom } from '@hapi/boom';
import EventEmitter2 from 'eventemitter2';
import { release } from 'os';
import P from 'pino';
import { execSync } from 'child_process';
import { RepositoryBroker } from '../repository/repository.manager';
import { MessageRaw, MessageUpdateRaw } from '../models/message.model';
import { ContactRaw } from '../models/contact.model';
import { ChatRaw } from '../models/chat.model';
import { getMIMEType } from 'node-mime-types';
import {
  ContactMessage,
  MediaMessage,
  Options,
  SendButtonDto,
  SendContactDto,
  SendListDto,
  SendLocationDto,
  SendMediaDto,
  SendReactionDto,
  SendTextDto,
} from '../dto/sendMessage.dto';
import { arrayUnique, isBase64, isURL } from 'class-validator';
import {
  ArchiveChatDto,
  OnWhatsAppDto,
  ReadMessageDto,
  WhatsAppNumberDto,
} from '../dto/chat.dto';
import { MessageQuery } from '../repository/message.repository';
import { ContactQuery } from '../repository/contact.repository';
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '../../exceptions';
import {
  CreateGroupDto,
  GroupJid,
  GroupPictureDto,
  GroupUpdateParticipantDto,
} from '../dto/group.dto';
import { WebhookDto } from '../dto/webhook.dto';
import { MessageUpQuery } from '../repository/messageUp.repository';
import { useMultiFileAuthStateDb } from '../../utils/use-multi-file-auth-state-db';
import Long from 'long';

export class WAStartupService {
  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly repository: RepositoryBroker,
  ) {
    this.cleanStore();
    this.instance.qrcode = { count: 0 };
  }

  private readonly logger = new Logger(WAStartupService.name);
  private readonly instance: wa.Instance = {};
  public client: WASocket;
  private readonly localWebhook: wa.LocalWebHook = {};
  private readonly msgRetryCounterMap: MessageRetryMap = {};
  private stateConnection: wa.StateConnection = {
    state: 'close',
  };
  private readonly storePath = join(ROOT_DIR, 'store');

  public set instanceName(name: string) {
    if (!name) {
      this.instance.name = v4();
      return;
    }
    this.instance.name = name;
    this.sendDataWebhook(Events.STATUS_INSTANCE, {
      instance: this.instance.name,
      status: 'created',
    });
  }

  public get instanceName() {
    return this.instance.name;
  }

  public get wuid() {
    return this.instance.wuid;
  }

  public get profileName() {
    let profileName = this.client.user?.name ?? this.client.user?.verifiedName;
    if (!profileName) {
      const creds = JSON.parse(
        readFileSync(join(INSTANCE_DIR, this.instanceName, 'cred.json'), {
          encoding: 'utf-8',
        }),
      );
      profileName = creds.me?.name ?? creds.me?.verifiedName;
    }
    return profileName;
  }

  public get profilePictureUrl() {
    return this.instance.profilePictureUrl;
  }

  public get qrCode(): wa.QrCode {
    return {
      code: this.instance.qrcode?.code,
      base64: this.instance.qrcode?.base64,
    };
  }

  private async loadWebhook() {
    const path = join(ROOT_DIR, 'store', 'webhook', this.instance.name + '.json');
    if (existsSync(path)) {
      try {
        const data = JSON.parse(
          readFileSync(path, { encoding: 'utf-8' }),
        ) as wa.LocalWebHook;
        Object.assign(this.localWebhook, data);
      } catch (error) {}
    }
  }

  public setWebhook(data: WebhookDto) {
    Object.assign(this.localWebhook, data);
  }

  private async sendDataWebhook<T = any>(event: Events, data: T) {
    const webhook = this.configService.get<Webhook>('WEBHOOK');
    const we = event.replace('.', '_').toUpperCase();
    if (webhook.EVENTS[we]) {
      try {
        if (this.localWebhook.enabled && isURL(this.localWebhook.url)) {
          const httpService = axios.create({ baseURL: this.localWebhook.url });
          await httpService.post(
            '',
            {
              event,
              instance: this.instance.name,
              data,
            },
            { params: { owner: this.instance.wuid } },
          );
        }

        const globalWebhhok = this.configService.get<Webhook>('WEBHOOK').GLOBAL;
        if (globalWebhhok && globalWebhhok?.ENABLED && isURL(globalWebhhok.URL)) {
          const httpService = axios.create({ baseURL: globalWebhhok.URL });
          await httpService.post(
            '',
            {
              event,
              instance: this.instance.name,
              data,
            },
            { params: { owner: this.instance.wuid } },
          );
        }
      } catch (error) {
        this.logger.error({
          local:
            WAStartupService.name + '.' + WAStartupService.prototype.sendDataWebhook.name,
          message: error?.message,
          hostName: error?.hostname,
          syscall: error?.syscall,
          code: error?.code,
          error: error?.errno,
          stack: error?.stack,
          name: error?.name,
        });
      } finally {
        data = undefined;
      }
    }
  }

  private async connectionUpdate(ev: BaileysEventEmitter) {
    ev.on('connection.update', async ({ qr, connection, lastDisconnect }) => {
      if (qr) {
        if (this.instance.qrcode.count === 6) {
          this.sendDataWebhook(Events.QRCODE_UPDATED, {
            message: 'QR code limit reached, please login again',
            statusCode: DisconnectReason.badSession,
          });

          this.sendDataWebhook(Events.CONNECTION_UPDATE, {
            instance: this.instance.name,
            state: 'refused',
            statusReason: DisconnectReason.connectionClosed,
          });

          this.sendDataWebhook(Events.STATUS_INSTANCE, {
            instance: this.instance.name,
            status: 'removed',
          });

          this.client.ev.removeAllListeners('connection.update');

          delete this.client.ev.on;

          return this.eventEmitter.emit('no.connection', this.instance.name);
        }

        this.instance.qrcode.count++;

        const optsQrcode: QRCodeToDataURLOptions = {
          margin: 3,
          scale: 4,
          errorCorrectionLevel: 'H',
          color: { light: '#ffffff', dark: '#198754' },
        };

        qrcode.toDataURL(qr, optsQrcode, (error, base64) => {
          if (error) {
            this.logger.error('Qrcode generare failed:' + error.toString());
            return;
          }

          this.instance.qrcode.base64 = base64;
          this.instance.qrcode.code = qr;

          this.sendDataWebhook(Events.QRCODE_UPDATED, {
            qrcode: { instance: this.instance.name, code: qr, base64 },
          });
        });

        qrcodeTerminal.generate(qr, { small: true }, (qrcode) =>
          this.logger.log(
            `\n{ instance: ${this.instance.name}, qrcodeCount: ${this.instance.qrcode.count} }\n` +
              qrcode,
          ),
        );
      }

      if (connection) {
        this.stateConnection = {
          state: connection,
          statusReason: (lastDisconnect?.error as Boom)?.output?.statusCode ?? 200,
        };
        this.sendDataWebhook(Events.CONNECTION_UPDATE, {
          instance: this.instance.name,
          ...this.stateConnection,
        });
      }

      if (connection === 'close') {
        const shouldRecnnect =
          (lastDisconnect.error as Boom)?.output?.statusCode !==
          DisconnectReason.loggedOut;
        if (shouldRecnnect) {
          await this.connectToWhatsapp();
        } else {
          this.sendDataWebhook(Events.STATUS_INSTANCE, {
            instance: this.instance.name,
            status: 'removed',
          });
          return this.eventEmitter.emit('remove.instance', this.instance.name);
        }
      }

      if (connection === 'open') {
        this.setHandles(this.client.ev);
        this.instance.wuid = this.client.user.id.replace(/:\d+/, '');
        this.instance.profilePictureUrl = (
          await this.profilePicture(this.instance.wuid)
        ).profilePictureUrl;
        this.logger.info(
          `
          ┌──────────────────────────────┐
          │    CONNECTED TO WHATSAPP     │
          └──────────────────────────────┘`.replace(/^ +/gm, '  '),
        );
      }
    });
  }

  private async getMessage(key: proto.IMessageKey): Promise<proto.IMessage> {
    try {
      const webMessageInfo: proto.IWebMessageInfo = JSON.parse(
        readFileSync(
          join(this.storePath, 'messages', this.instance.wuid, key.id + '.json'),
          { encoding: 'utf-8' },
        ),
      );
      return webMessageInfo.message;
    } catch (error) {
      return { conversation: '' };
    }
  }

  private cleanStore() {
    const store = this.configService.get<StoreConf>('STORE');
    const database = this.configService.get<Database>('DATABASE');
    if (store?.CLEANING_INTARVAL && !database.ENABLED) {
      setInterval(() => {
        try {
          for (const [key, value] of Object.entries(store)) {
            if (value === true) {
              execSync(
                `rm -rf ${join(
                  this.storePath,
                  key.toLowerCase(),
                  this.instance.wuid,
                )}/*.json`,
              );
            }
          }
        } catch (error) {}
      }, (store?.CLEANING_INTARVAL ?? 3600) * 1000);
    }
  }

  public async connectToWhatsapp() {
    this.loadWebhook();

    this.instance.authState = this.configService.get<Database>('DATABASE').ENABLED
      ? await useMultiFileAuthStateDb(this.instance.name)
      : await useMultiFileAuthState(join(INSTANCE_DIR, this.instance.name));

    const { version } = await fetchLatestBaileysVersion();
    const session = this.configService.get<ConfigSessionPhone>('CONFIG_SESSION_PHONE');
    const browser: WABrowserDescription = [session.CLIENT, session.NAME, release()];

    const socketConfig: UserFacingSocketConfig = {
      auth: this.instance.authState.state,
      logger: P({ level: 'error' }),
      msgRetryCounterMap: this.msgRetryCounterMap,
      printQRInTerminal: false,
      browser,
      version,
      connectTimeoutMs: 60_000,
      emitOwnEvents: false,
      getMessage: this.getMessage,
    };

    this.client = makeWASocket(socketConfig);
    this.connectionUpdate(this.client.ev);

    this.client.ev.on('creds.update', this.instance.authState.saveCreds);

    return this;
  }

  private chatHandle(ev: BaileysEventEmitter) {
    ev.on('chats.set', async ({ chats, isLatest }) => {
      if (isLatest) {
        const chatsRaw: ChatRaw[] = chats.map((chat) => {
          return {
            id: chat.id,
            owner: this.instance.name,
          };
        });
        await this.sendDataWebhook(Events.CHATS_SET, chatsRaw);
        // await this.repository.chat.insert(chatsRaw, database.SAVE_DATA.CHATS);
      }
    });

    ev.on('chats.upsert', async (chats) => {
      const chatsRaw: ChatRaw[] = chats.map((chat) => {
        return {
          id: chat.id,
          owner: this.instance.name,
        };
      });
      await this.sendDataWebhook(Events.CHATS_UPSERT, chatsRaw);
    });

    ev.on('chats.update', async (chats) => {
      const chatsRaw: ChatRaw[] = chats.map((chat) => {
        return {
          id: chat.id,
          owner: this.instance.name,
        };
      });
      await this.sendDataWebhook(Events.CHATS_UPDATE, chatsRaw);
    });
  }

  private contactHandle(ev: BaileysEventEmitter) {
    const database = this.configService.get<Database>('DATABASE');
    ev.on('contacts.upsert', async (contacts) => {
      const contactsRepository = await this.repository.contact.find({
        where: { owner: this.instance.wuid },
      });

      const contactsRaw: ContactRaw[] = [];
      for await (const contact of contacts) {
        if (contactsRepository.find((cr) => cr.id === contact.id)) {
          continue;
        }

        contactsRaw.push({
          id: contact.id,
          pushName: contact?.name || contact?.verifiedName,
          profilePictureUrl: (await this.profilePicture(contact.id)).profilePictureUrl,
          owner: this.instance.wuid,
        });
      }
      await this.sendDataWebhook(Events.CONTACTS_UPSERT, contactsRaw);
      await this.repository.contact.insert(contactsRaw, database.SAVE_DATA.CONTACTS);
    });

    ev.on('contacts.update', async (contacts) => {
      const contactsRaw: ContactRaw[] = [];
      for await (const contact of contacts) {
        contactsRaw.push({
          id: contact.id,
          pushName: contact?.name ?? contact?.verifiedName,
          profilePictureUrl: (await this.profilePicture(contact.id)).profilePictureUrl,
          owner: this.instance.wuid,
        });
      }
      await this.sendDataWebhook(Events.CONTACTS_UPDATE, contactsRaw);
    });
  }

  private messageHandle(ev: BaileysEventEmitter) {
    const database = this.configService.get<Database>('DATABASE');
    ev.on('messages.set', async ({ messages, isLatest }) => {
      const messagesRaw: MessageRaw[] = [];
      const messagesRepository = await this.repository.message.find({
        where: { owner: this.instance.wuid },
      });
      for await (const [, m] of Object.entries(messages)) {
        if (
          m.message?.protocolMessage ||
          m.message?.senderKeyDistributionMessage ||
          !m.message
        ) {
          continue;
        }
        if (
          messagesRepository.find(
            (mr) => mr.owner === this.instance.wuid && mr.key.id === m.key.id,
          )
        ) {
          continue;
        }

        if (Long.isLong(m?.messageTimestamp)) {
          m.messageTimestamp = m.messageTimestamp?.toNumber();
        }

        messagesRaw.push({
          key: m.key,
          pushName: m.pushName,
          message: { ...m.message },
          messageTimestamp: m.messageTimestamp as number,
          owner: this.instance.wuid,
        });
      }

      await this.repository.message.insert(
        [...messagesRaw],
        database.SAVE_DATA.OLD_MESSAGE,
      );
      this.sendDataWebhook(Events.MESSAGES_SET, [...messagesRaw]);
      messages = undefined;
    });

    ev.on('messages.upsert', async ({ messages, type }) => {
      const received = messages[0];
      if (
        type !== 'notify' ||
        !received?.message ||
        received.message?.protocolMessage ||
        received.message.senderKeyDistributionMessage
      ) {
        return;
      }

      if (Long.isLong(received.messageTimestamp)) {
        received.messageTimestamp = received.messageTimestamp?.toNumber();
      }

      const messageRaw: MessageRaw = {
        key: received.key,
        pushName: received.pushName,
        message: { ...received.message },
        messageTimestamp: received.messageTimestamp as number,
        owner: this.instance.wuid,
        source: getDevice(received.key.id),
      };

      this.logger.log(received);

      await this.repository.message.insert([messageRaw], database.SAVE_DATA.NEW_MESSAGE);
      await this.sendDataWebhook(Events.MESSAGES_UPSERT, messageRaw);
    });

    ev.on('messages.update', async (args) => {
      const status: Record<number, wa.StatusMessage> = {
        0: 'ERROR',
        1: 'PENDING',
        2: 'SERVER_ACK',
        3: 'DELIVERY_ACK',
        4: 'READ',
        5: 'PLAYED',
      };
      for await (const { key, update } of args) {
        if (key.remoteJid !== 'status@broadcast' && !key?.remoteJid?.match(/(:\d+)/)) {
          const message: MessageUpdateRaw = {
            ...key,
            status: status[update.status],
            datetime: Date.now(),
            owner: this.instance.wuid,
          };
          await this.sendDataWebhook(Events.MESSAGES_UPDATE, message);
          await this.repository.messageUpdate.insert(
            [message],
            database.SAVE_DATA.MESSAGE_UPDATE,
          );
        }
      }
    });
  }

  private presenceHandle(ev: BaileysEventEmitter) {
    ev.on('presence.update', async (presence) => {
      await this.sendDataWebhook(Events.PRESENCE_UPDATE, presence);
    });
  }

  private setHandles(ev: BaileysEventEmitter) {
    this.chatHandle(ev);
    this.contactHandle(ev);
    this.messageHandle(ev);
    this.presenceHandle(ev);
  }

  private createJid(number: string) {
    if (number.includes('@g.us') || number.includes('@s.whatsapp.net')) {
      return this.formatBRNumber(number) as string;
    }
    return number.includes('-')
      ? `${number}@g.us`
      : `${this.formatBRNumber(number)}@s.whatsapp.net`;
  }

  // Check if the number is br
  private formatBRNumber(jid: string) {
    const regexp = new RegExp(/^(\d{2})(\d{2})\d{1}(\d{8})$/);
    if (regexp.test(jid)) {
      const match = regexp.exec(jid);
      if (match && match[1] === '55' && Number.isInteger(Number.parseInt(match[2]))) {
        const ddd = Number.parseInt(match[2]);
        if (ddd < 31) {
          return match[0];
        } else if (ddd >= 31) {
          return match[1] + match[2] + match[3];
        }
      }
    } else {
      return jid;
    }
  }

  public async profilePicture(number: string) {
    const jid = this.createJid(number);
    try {
      return {
        wuid: jid,
        profilePictureUrl: await this.client.profilePictureUrl(jid, 'image'),
      };
    } catch (error) {
      return {
        wuid: jid,
        profilePictureUrl: null,
      };
    }
  }

  private async sendMessageWithTyping(
    number: string,
    message: proto.IMessage,
    options?: Options,
  ) {
    try {
      const jid = this.createJid(number);
      if (options?.delay) {
        await this.client.presenceSubscribe(jid);
        await this.client.sendPresenceUpdate(options?.presence ?? 'composing', jid);
        await delay(options.delay);
        await this.client.sendPresenceUpdate('paused', jid);
      }

      const messageSent = await this.client.sendMessage(jid, {
        forward: {
          key: { remoteJid: this.instance.wuid, fromMe: true },
          message,
        },
      });

      this.sendDataWebhook(Events.SEND_MESSAGE, messageSent).catch((error) =>
        this.logger.error(error),
      );
      this.repository.message
        .insert(
          [{ ...messageSent, owner: this.instance.wuid }],
          this.configService.get<Database>('DATABASE').SAVE_DATA.NEW_MESSAGE,
        )
        .catch((error) => this.logger.error(error));

      return messageSent;
    } catch (error) {
      throw new BadRequestException(error.toString());
    }
  }

  // Instance Controller
  public get connectionStatus() {
    return this.stateConnection;
  }

  // Send Message Controller
  public async textMessage(data: SendTextDto) {
    return await this.sendMessageWithTyping(
      data.number,
      {
        extendedTextMessage: {
          text: data.textMessage.text,
        },
      },
      data?.options,
    );
  }

  private async prepareMediaMessage(mediaMessage: MediaMessage) {
    const prepareMedia = await prepareWAMessageMedia(
      {
        [mediaMessage.mediatype]: isURL(mediaMessage.media)
          ? { url: mediaMessage.media }
          : Buffer.from(mediaMessage.media, 'base64'),
      } as any,
      { upload: this.client.waUploadToServer },
    );

    const type = mediaMessage.mediatype + 'Message';

    if (mediaMessage.mediatype === 'document' && !mediaMessage.fileName) {
      const regex = new RegExp(/.*\/(.+?)\./);
      const arryMatch = regex.exec(mediaMessage.media);
      mediaMessage.fileName = arryMatch[1];
    }

    let mimetype: string;

    if (isURL(mediaMessage.media)) {
      mimetype = getMIMEType(mediaMessage.media);
    } else {
      mimetype = getMIMEType(mediaMessage.fileName);
    }

    prepareMedia[type].caption = mediaMessage?.caption;
    prepareMedia[type].mimetype = mimetype;
    prepareMedia[type].fileName = mediaMessage.fileName;

    return generateWAMessageFromContent(
      '',
      { [type]: { ...prepareMedia[type] } },
      { userJid: this.instance.wuid },
    );
  }

  public async mediaMessage(data: SendMediaDto) {
    const generate = await this.prepareMediaMessage(data.mediaMessage);

    return await this.sendMessageWithTyping(
      data.number,
      { ...generate.message },
      data?.options,
    );
  }

  public async buttonMessage(data: SendButtonDto) {
    const embeddMedia: any = {};
    let mediatype = 'TEXT';

    if (data.buttonMessage?.mediaMessage) {
      mediatype = data.buttonMessage.mediaMessage?.mediatype.toUpperCase() ?? 'TEXT';
      embeddMedia.mediaKey = mediatype.toLowerCase() + 'Message';
      const generate = await this.prepareMediaMessage(data.buttonMessage.mediaMessage);
      embeddMedia.message = generate.message[embeddMedia.mediaKey];
      embeddMedia.contentText = `*${data.buttonMessage.title}*\n\n${data.buttonMessage.description}`;
    }

    const btnItens = {
      text: data.buttonMessage.buttons.map((btn) => btn.buttonText),
      ids: data.buttonMessage.buttons.map((btn) => btn.buttonId),
    };

    if (!arrayUnique(btnItens.text) || !arrayUnique(btnItens.ids)) {
      throw new BadRequestException(
        'Button texts cannot be repeated',
        'Button IDs cannot be repeated.',
      );
    }

    return await this.sendMessageWithTyping(
      data.number,
      {
        buttonsMessage: {
          text: !embeddMedia?.mediaKey ? data.buttonMessage.title : undefined,
          contentText: embeddMedia?.contentText ?? data.buttonMessage.description,
          footerText: data.buttonMessage?.footerText,
          buttons: data.buttonMessage.buttons.map((button) => {
            return {
              buttonText: {
                displayText: button.buttonText,
              },
              buttonId: button.buttonId,
              type: 1,
            };
          }),
          headerType: proto.Message.ButtonsMessage.HeaderType[mediatype],
          [embeddMedia?.mediaKey]: embeddMedia?.message,
        },
      },
      data?.options,
    );
  }

  public async locationMessage(data: SendLocationDto) {
    return await this.sendMessageWithTyping(
      data.number,
      {
        locationMessage: {
          degreesLatitude: data.locationMessage.latitude,
          degreesLongitude: data.locationMessage.longitude,
          name: data.locationMessage?.name,
          address: data.locationMessage?.address,
        },
      },
      data?.options,
    );
  }

  public async listMessage(data: SendListDto) {
    return await this.sendMessageWithTyping(
      data.number,
      {
        listMessage: {
          title: data.listMessage.title,
          description: data.listMessage.description,
          buttonText: data.listMessage?.buttonText,
          footerText: data.listMessage?.footerText,
          sections: data.listMessage.sections,
          listType: 1,
        },
      },
      data?.options,
    );
  }

  public async contactMessage(data: SendContactDto) {
    const messsage: proto.IMessage = {};

    const vcard = (contact: ContactMessage) => {
      return (
        'BEGIN:VCARD\n' +
        'VERSION:3.0\n' +
        'FN:' +
        contact.fullName +
        '\n' +
        'item1.TEL;waid=' +
        this.formatBRNumber(contact.wuid) +
        ':' +
        contact.phoneNumber +
        '\n' +
        'item1.X-ABLabel:Celular\n' +
        'END:VCARD'
      );
    };

    if (data.contactMessage.length === 1) {
      messsage.contactMessage = {
        displayName: data.contactMessage[0].fullName,
        vcard: vcard(data.contactMessage[0]),
      };
    } else {
      messsage.contactsArrayMessage = {
        displayName: `${data.contactMessage.length} contacts`,
        contacts: data.contactMessage.map((contact) => {
          return {
            displayName: contact.fullName,
            vcard: vcard(contact),
          };
        }),
      };
    }

    return await this.sendMessageWithTyping(data.number, { ...messsage }, data?.options);
  }

  public async reactionMessage(data: SendReactionDto) {
    return await this.sendMessageWithTyping(data.reactionMessage.key.remoteJid, {
      reactionMessage: {
        key: data.reactionMessage.key,
        text: data.reactionMessage.reaction,
      },
    });
  }

  // Chat Controller
  public async whatsappNumber(data: WhatsAppNumberDto) {
    const onWhatsapp: OnWhatsAppDto[] = [];
    for await (const number of data.numbers) {
      const jid = this.createJid(number);
      try {
        const result = await this.client.onWhatsApp(jid);
        onWhatsapp.push(new OnWhatsAppDto(result[0].jid, result[0].exists));
      } catch (error) {
        onWhatsapp.push(new OnWhatsAppDto(number, false));
      }
    }

    return onWhatsapp;
  }

  public async markMessageAsRead(data: ReadMessageDto) {
    try {
      const keys: proto.IMessageKey[] = [];
      data.readMessages.forEach((read) => {
        if (isJidGroup(read.remoteJid) || isJidUser(read.remoteJid)) {
          keys.push({
            remoteJid: read.remoteJid,
            fromMe: read.fromMe,
            id: read.id,
          });
        }
      });
      await this.client.readMessages(keys);
      return { message: 'Read messages', read: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Read messages fail', error.toString());
    }
  }

  public async archiveChat(data: ArchiveChatDto) {
    try {
      data.lastMessage.messageTimestamp =
        data.lastMessage?.messageTimestamp ?? Date.now();
      await this.client.chatModify(
        {
          archive: data.archive,
          lastMessages: [data.lastMessage],
        },
        data.lastMessage.key.remoteJid,
      );

      return {
        chatId: data.lastMessage.key.remoteJid,
        archived: true,
      };
    } catch (error) {
      throw new InternalServerErrorException({
        archived: false,
        message: [
          'An error occurred while archiving the chat. Open a calling.',
          error.toString(),
        ],
      });
    }
  }

  public async getBase64FromMediaMessage(m: proto.IWebMessageInfo) {
    try {
      const typeMessage = [
        'imageMessage',
        'documentMessage',
        'audioMessage',
        'videoMessage',
        'stickerMessage',
      ];

      let mediaMessage: any;
      let mediaType: string;

      for (const type of typeMessage) {
        mediaMessage = m.message[type];
        if (mediaMessage) {
          mediaType = type;
          break;
        }
      }

      if (!mediaMessage) {
        throw 'The message is not of the media type';
      }

      const buffer = await downloadMediaMessage(
        m,
        'buffer',
        {},
        {
          logger: P({ level: 'error' }),
          reuploadRequest: this.client.updateMediaMessage,
        },
      );

      return {
        mediaType,
        fileName: mediaMessage['fileName'],
        caption: mediaMessage['caption'],
        size: {
          fileLength: mediaMessage['fileLength'],
          height: mediaMessage['height'],
          width: mediaMessage['width'],
        },
        mimetype: mediaMessage['mimetype'],
        base64: buffer.toString('base64'),
      };
    } catch (error) {
      throw new BadRequestException(error.toString());
    }
  }

  public async fetchContacts(query: ContactQuery) {
    if (query?.where) {
      query.where.owner = this.instance.wuid;
    } else {
      query = {
        where: {
          owner: this.instance.wuid,
        },
      };
    }
    return await this.repository.contact.find(query);
  }

  public async fetchMessages(query: MessageQuery) {
    if (query?.where) {
      query.where.owner = this.instance.wuid;
    } else {
      query = {
        where: {
          owner: this.instance.wuid,
        },
        limit: query?.limit,
      };
    }
    if (query?.where?.key) {
      for (const [k, v] of Object.entries(query.where.key)) {
        query.where['key.' + k] = v;
      }
    }
    return await this.repository.message.find(query);
  }

  public async findStatusMessage(query: MessageUpQuery) {
    if (query?.where) {
      query.where.owner = this.instance.wuid;
    } else {
      query = {
        where: {
          owner: this.instance.wuid,
        },
        limit: query?.limit,
      };
    }
    return await this.repository.messageUpdate.find(query);
  }

  // Group
  public async createGroup(create: CreateGroupDto) {
    try {
      const participants = create.participants.map((p) => this.createJid(p));
      const { id } = await this.client.groupCreate(create.subject, participants);
      if (create?.description) {
        await this.client.groupUpdateDescription(id, create.description);
      }

      const group = await this.client.groupMetadata(id);

      return { groupMetadata: group };
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException('Error creating group', error.toString());
    }
  }

  public async updateGroupPicture(picture: GroupPictureDto) {
    try {
      let pic: WAMediaUpload;
      if (isURL(picture.image)) {
        pic = (await axios.get(picture.image, { responseType: 'arraybuffer' })).data;
      } else if (isBase64(picture.image)) {
        pic = Buffer.from(picture.image, 'base64');
      } else {
        throw new BadRequestException('"profilePicture" must be a url or a base64');
      }
      await this.client.updateProfilePicture(picture.groupJid, pic);

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error creating group', error.toString());
    }
  }

  public async findGroup(id: GroupJid) {
    try {
      return await this.client.groupMetadata(id.groupJid);
    } catch (error) {
      throw new NotFoundException('Error fetching group', error.toString());
    }
  }

  public async invitCode(id: GroupJid) {
    try {
      const code = await this.client.groupInviteCode(id.groupJid);
      return { inviteUrl: `https://chat.whatsapp.com/${code}`, inviteCode: code };
    } catch (error) {
      throw new NotFoundException('No invite code', error.toString());
    }
  }

  public async revokeInviteCode(id: GroupJid) {
    try {
      const inviteCode = await this.client.groupRevokeInvite(id.groupJid);
      return { revoked: true, inviteCode };
    } catch (error) {
      throw new NotFoundException('Revoke error', error.toString());
    }
  }

  public async findParticipants(id: GroupJid) {
    try {
      const participants = (await this.client.groupMetadata(id.groupJid)).participants;
      return { participants };
    } catch (error) {
      throw new NotFoundException('No participants', error.toString());
    }
  }

  public async updateGParticipant(update: GroupUpdateParticipantDto) {
    try {
      const participants = update.participants.map((p) => this.createJid(p));
      const updatePaticipants = await this.client.groupParticipantsUpdate(
        update.groupJid,
        participants,
        update.action,
      );
      return { updatePaticipants };
    } catch (error) {
      throw new BadRequestException('Error updating participants', error.toString());
    }
  }

  public async leaveGroup(id: GroupJid) {
    try {
      await this.client.groupLeave(id.groupJid);
      return { groupJid: id.groupJid, leave: true };
    } catch (error) {
      throw new BadRequestException('Unable to leave the group', error.toString());
    }
  }
}
