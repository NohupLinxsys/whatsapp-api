import { NextFunction, Request, Response } from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import { INSTANCE_DIR } from '../../config/path.config';
import { db, mongoClient } from '../../db/db.connect';
import {
  BadRequestException,
  ForbidenException,
  NotFoundException,
} from '../../exceptions';
import { InstanceDto } from '../dto/instance.dto';
import { waMonitor } from '../whatsapp.module';

async function getInstance(instanceName: string) {
  const exists = waMonitor.waInstances[instanceName];

  if (db.ENABLED) {
    const collection = mongoClient
      .db(db.CONNECTION.DB_PREFIX_NAME + '-instances')
      .collection(instanceName);
    return (await collection.find({}).toArray()).length > 0;
  }

  return exists || existsSync(join(INSTANCE_DIR, instanceName));
}

export async function instanceExistsGuard(req: Request, _: Response, next: NextFunction) {
  if (
    req.originalUrl.includes('/instance/create') ||
    req.originalUrl.includes('/instance/fetchInstances')
  ) {
    return next();
  }

  const param = req.params as unknown as InstanceDto;
  if (!param?.instanceName) {
    throw new BadRequestException('"instanceName" not provided.');
  }

  if (!(await getInstance(param.instanceName))) {
    throw new NotFoundException(`The "${param.instanceName}" instance does not exist`);
  }

  next();
}

export async function instanceLoggedGuard(req: Request, _: Response, next: NextFunction) {
  if (req.originalUrl.includes('/instance/create')) {
    const instance = req.body as InstanceDto;
    if (await getInstance(instance.instanceName)) {
      throw new ForbidenException(
        `This name "${instance.instanceName}" is already in use.`,
      );
    }

    if (waMonitor.waInstances[instance.instanceName]) {
      delete waMonitor.waInstances[instance.instanceName];
    }
  }

  next();
}
