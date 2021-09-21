import {
  ObjectCannedACL as ACL,
  S3Client,
  GetObjectCommand,
  GetObjectCommandOutput,
  GetObjectAclCommand,
} from '@aws-sdk/client-s3';
import * as JSON5 from 'json5';

type ObjectPath = {
  Bucket: string;
  Key: string;
  Ext: string;
};

type ParseObjectPath = (path: string) => ObjectPath;

type IsObjectBinary = (data: GetObjectCommandOutput) => boolean;

type SelectACL = () => Promise<ACL>;

type ShowDiff = (prev: string, next: string) => void;

type PromptConfirm = (message: string) => Promise<boolean>;

type InputPrompt = (text: string) => Promise<string>;

type EnsureJson = (data: string) => string;

type FetchObject = (deps: {
  client: S3Client;
  isBinary: IsObjectBinary;
}) => (objectPath: ObjectPath) => Promise<string | null>;

type UpdateObject = (deps: {
  prompt: InputPrompt;
  ensureJson: EnsureJson;
}) => (objectPath: ObjectPath, prevText: string | null) => Promise<string>;

type Confirm = (deps: {
  showDiff: ShowDiff;
  promptConfirm: PromptConfirm;
}) => (objectPath: ObjectPath, data: { prevText: string | null; nextText: string }, acl: ACL) => Promise<void>;

type PushObject = (deps: { client: S3Client }) => (objectPath: ObjectPath, data: string, acl: ACL) => Promise<void>;

class CustomError extends Error {
  constructor(message: string) {
    super(message);
  }
}

const fetchObject: FetchObject = ({ client, isBinary }) => async ({ Bucket, Key }) => {
  try {
    const s3Object = await client.send(
      new GetObjectCommand({
        Bucket,
        Key,
      })
    );
    if (isBinary(s3Object)) {
      throw new CustomError(`Cannot handle binary object.`);
    }
    return s3Object.Body?.toString() || '';
  } catch (e) {
    if (e.name === 'NotFound') {
      return null;
    }
    throw e;
  }
};

const updateObject: UpdateObject = ({ prompt, ensureJson }) => async (objectPath, text) => {
  let updatedText = await prompt(text || '');
  if (objectPath.Ext === 'json') {
    updatedText = ensureJson(updatedText);
  }
  return updatedText;
};

declare const parseObjectPath: ParseObjectPath;
declare const isBinary: IsObjectBinary;
declare const confirm: Confirm;
declare const pushObject: PushObject;
declare const selectACL: SelectACL;
declare const showDiff: ShowDiff;
declare const ensureJson: EnsureJson;
declare const vimPrompt: InputPrompt;
declare const promptConfirm: PromptConfirm;

function bootStrap(client: S3Client) {
  return {
    fetch: fetchObject({ client, isBinary }),
    update: updateObject({
      prompt: vimPrompt,
      ensureJson,
    }),
    confirm: confirm({ promptConfirm, showDiff }),
    push: pushObject({ client }),
  } as const;
}

async function main(path: string) {
  try {
    const objectPath = parseObjectPath(path);
    const { confirm, fetch, push, update } = bootStrap(new S3Client({}));

    const prevText = await fetch(objectPath);
    const nextText = await update(objectPath, prevText);
    const acl = await selectACL();
    await confirm(objectPath, { nextText, prevText }, acl);
    await push(objectPath, nextText, acl);
  } catch (e) {
    if (e instanceof CustomError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

main(process.argv[2]);
